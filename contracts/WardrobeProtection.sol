// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title Wardrobe Protection: risk-priced cover for authenticated resale
/// @notice Sits next to WardrobePassportV3 and reads its public records. It adds
///         three things the marketplace contract does not have:
///
///         1. Authenticators back their stamp with money. A partner (a pawn
///            shop, watchmaker, gemologist or any approved expert) stakes a
///            bond. Every covered piece it authenticated locks part of that
///            bond. If the piece is later proven fake, the bond pays first.
///         2. Cover that lasts after delivery. The marketplace holds the money
///            only until the buyer confirms. This contract covers the buyer for
///            90 days after that, when most fakes are actually discovered.
///         3. A price for trust. The fee for cover is worked out on-chain from
///            the seller's record, the record of whoever invited the seller,
///            and the shop's record. Members fund the pool that pays claims and
///            earn the fees.
///
///         4. Specialists by category. Each partner is approved for specific
///            categories (watches, vintage watches, jewelry, handbags...). Only
///            a specialist can certify a piece for cover, only a specialist in
///            the same category can rule on a claim, each category has its own
///            base rate, and a partner's record is kept per category.
///
///         A claim is decided by a second partner that re-inspects the piece
///         (never the one that stamped it). Nothing here is specific to
///         clothes: it works for any item an expert can inspect.
/// @dev Built for Arc, where USDC is the native currency (18 decimals).
///      This is community protection on test dollars, not a licensed insurance product.

interface IWardrobePassportV3 {
    struct Item {
        string name; string brand; string details; string imageUrl;
        address owner; address buyer; address partner; address authBy;
        uint256 price; uint256 deposit;
        uint64 paidAt; uint64 shippedAt; uint64 authAt;
        uint8 status; // 0 Owned, 1 Listed, 2 Paid, 3 Shipped, 4 Disputed
        string authNote; uint256 disputeId;
    }
    struct Transfer { address from; address to; uint256 price; uint64 at; }

    function admin() external view returns (address);
    function getItem(uint256 id) external view returns (Item memory);
    function getHistory(uint256 id) external view returns (Transfer[] memory);
    function members(address a) external view returns (address invitedBy, address verifiedBy, uint64 joinedAt, uint64 verifiedAt, bool active);
    function partners(address a) external view returns (string memory name, string memory city, bool active, uint32 authenticated, uint32 disputesResolved, uint32 reportsFiled, uint32 membersVerified);
    function records(address a) external view returns (uint32 sold, uint32 bought, uint32 refundsGiven, uint32 disputesWon, uint32 disputesLost, uint32 votesCast, uint32 votesWithMajority, uint32 inviteesDisputesLost);
}

contract WardrobeProtection {
    // ---------------------------------------------------------------------
    // Rating table (all in basis points of the price; 100 bps = 1%)
    // ---------------------------------------------------------------------

    // The base rate is set per category (see categories).
    int256 public constant NEW_SELLER_LOADING = 200;       // seller with no completed sales
    int256 public constant SALE_CREDIT = 25;               // per completed sale...
    int256 public constant MAX_SALE_CREDIT = 150;          // ...up to 6 sales
    int256 public constant DISPUTE_LOST_LOADING = 300;     // per dispute the seller lost
    int256 public constant REFUND_LOADING = 100;           // per refund the seller had to give
    int256 public constant SELLER_FAKE_LOADING = 500;      // per upheld fake claim against the seller
    int256 public constant INVITER_LOADING = 100;          // per dispute lost by people the seller's inviter brought in...
    int256 public constant MAX_INVITER_LOADING = 300;      // ...capped
    int256 public constant SHOP_FAKE_LOADING = 400;        // per fake this shop stamped as real
    int256 public constant SHOP_CLEAN_CREDIT = 50;         // shop with 10+ stamps and no fakes
    uint32 public constant SHOP_CLEAN_MIN_STAMPS = 10;
    int256 public constant MIN_BPS = 100;                  // floor 1%
    int256 public constant MAX_BPS = 2000;                 // cap 20%

    uint64 public constant COVER_WINDOW = 90 days;         // cover lasts this long after delivery
    uint64 public constant REVIEW_WINDOW = 3 days;         // after this the admin may decide a claim
    uint256 public constant SHOP_SHARE_BPS = 5000;         // shop's bond pays the first 50% of a claim
    uint256 public constant CLAIM_DEPOSIT_BPS = 500;       // buyer posts 5% to file a claim
    uint256 public constant REVIEW_FEE_BPS = 200;          // second shop earns 2% for the re-inspection

    // ---------------------------------------------------------------------
    // Data
    // ---------------------------------------------------------------------

    enum State { Pending, Active, Claimed, Paid, Rejected, Expired, Void }

    struct Cover {
        uint256 itemId;
        address buyer;
        address seller;
        address shop;          // partner whose stamp is covered
        uint256 amount;        // covered amount = sale price
        uint256 fee;           // what the buyer paid for cover
        uint16 feeBps;
        uint64 paidAt;         // the sale this cover belongs to
        uint64 boughtAt;
        uint64 deliveredAt;    // 0 until the sale completes
        uint256 shopLock;      // part of the shop's bond held behind this cover
        uint256 poolLock;      // part of the pool held behind this cover
        State state;
        bytes32 category;
        uint64 claimedAt;
        uint256 claimDeposit;
        address reviewer;
        string evidence;
        string ruling;
    }

    struct Category { string name; int256 baseBps; bool active; }

    IWardrobePassportV3 public immutable passport;

    // Categories and specialists
    mapping(bytes32 => Category) public categories;
    bytes32[] private _categoryList;
    mapping(address => mapping(bytes32 => bool)) public specialistIn;     // partner => category => approved
    mapping(address => mapping(bytes32 => string)) public credentialOf;   // e.g. "Certified watchmaker, 20 years"
    mapping(uint256 => bytes32) public categoryOf;                        // item => category it was certified in
    mapping(address => mapping(bytes32 => uint32)) public fakesStampedIn; // partner's fakes per category

    uint256 public coverCount;
    mapping(uint256 => Cover) private _covers;
    mapping(bytes32 => uint256) public coverOfSale; // keccak(itemId, buyer, paidAt) => cover id

    // Shop bonds
    mapping(address => uint256) public bondOf;
    mapping(address => uint256) public bondLocked;
    mapping(address => uint32) public fakesStampedBy;   // upheld claims against a shop's stamp
    mapping(address => uint32) public stampsCovered;    // covers written on a shop's stamp

    // Seller and buyer records kept here (the marketplace keeps the rest)
    mapping(address => uint32) public fakesSoldBy;
    mapping(address => uint32) public claimsRejectedOf;

    // Member-funded pool
    uint256 public poolAssets;   // money the pool owns (stakes + fees - payouts)
    uint256 public poolLocked;   // part of it held behind live covers
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    uint256 public feesEarned;
    uint256 public claimsPaid;

    mapping(address => uint256) public owed;
    uint256 private _lock = 1;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event CategorySet(bytes32 indexed category, string name, int256 baseBps, bool active);
    event SpecialistSet(address indexed partner, bytes32 indexed category, bool approved, string credential);
    event Certified(uint256 indexed itemId, address indexed partner, bytes32 indexed category);
    event BondStaked(address indexed shop, uint256 amount, uint256 total);
    event BondWithdrawn(address indexed shop, uint256 amount, uint256 total);
    event PoolDeposit(address indexed member, uint256 amount, uint256 shares);
    event PoolWithdrawal(address indexed member, uint256 amount, uint256 shares);
    event CoverBought(uint256 indexed coverId, uint256 indexed itemId, address indexed buyer, address seller, address shop, bytes32 category, uint256 amount, uint256 fee, uint16 feeBps);
    event CoverActivated(uint256 indexed coverId, uint64 deliveredAt, uint64 expiresAt);
    event CoverVoided(uint256 indexed coverId, uint256 feeRefunded);
    event CoverExpired(uint256 indexed coverId);
    event ClaimFiled(uint256 indexed coverId, address indexed buyer, uint256 deposit, string evidence);
    event ClaimDecided(uint256 indexed coverId, address indexed reviewer, bool fake, string ruling);
    event ClaimPaid(uint256 indexed coverId, address indexed buyer, uint256 fromShopBond, uint256 fromPool);
    event PayoutDeferred(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotAdmin();
    error NotPartner();
    error NotSpecialist();
    error NotCertified();
    error NoSuchCategory();
    error InvalidRate();
    error InSale();
    error NotMember();
    error NotBuyer();
    error NotReviewer();
    error NotInSale();
    error NotAuthenticated();
    error AlreadyCovered();
    error WrongAmount();
    error WrongState();
    error ShopBondTooLow();
    error PoolTooSmall();
    error FundsLocked();
    error NotDelivered();
    error StillInSale();
    error CoverEnded();
    error NotExpired();
    error NoLongerOwner();
    error NoSuchCover();
    error NothingOwed();
    error TransferFailed();
    error Reentrancy();

    constructor(address passportV3) {
        passport = IWardrobePassportV3(passportV3);
        // Launch categories. Vintage pieces are harder to judge, so they start higher.
        _setCategory("watches", "Watches", 300, true);
        _setCategory("vintage-watches", "Vintage watches", 400, true);
        _setCategory("jewelry", "Jewelry", 300, true);
        _setCategory("handbags", "Handbags", 300, true);
    }

    modifier onlyAdmin() { if (msg.sender != passport.admin()) revert NotAdmin(); _; }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ---------------------------------------------------------------------
    // Categories and specialists
    // ---------------------------------------------------------------------

    /// @notice Add a category or change its base rate (admin). Example: "clothing" later.
    function setCategory(bytes32 key, string calldata name, int256 baseBps, bool active) external onlyAdmin {
        _setCategory(key, name, baseBps, active);
    }

    /// @notice Approve (or remove) a partner as a specialist in a category, with a note on why
    ///         they are qualified. The admin checks the credential off-chain first.
    function setSpecialist(address partner, bytes32 key, bool approved, string calldata credential) external onlyAdmin {
        if (bytes(categories[key].name).length == 0) revert NoSuchCategory();
        (, , bool active, , , , ) = passport.partners(partner);
        if (!active) revert NotPartner();
        specialistIn[partner][key] = approved;
        credentialOf[partner][key] = approved ? credential : "";
        emit SpecialistSet(partner, key, approved, credential);
    }

    /// @notice The partner that authenticated a piece says which category it judged it in.
    ///         Only a specialist in that category can do this, and only then can the piece be covered.
    function certify(uint256 itemId, bytes32 key) external {
        IWardrobePassportV3.Item memory it = passport.getItem(itemId);
        if (it.authBy != msg.sender) revert NotPartner();
        if (!categories[key].active) revert NoSuchCategory();
        if (!specialistIn[msg.sender][key]) revert NotSpecialist();
        if (it.status == 2 || it.status == 3 || it.status == 4) revert InSale(); // not mid-sale
        categoryOf[itemId] = key;
        emit Certified(itemId, msg.sender, key);
    }

    function getCategories() external view returns (bytes32[] memory) { return _categoryList; }

    function _setCategory(bytes32 key, string memory name, int256 baseBps, bool active) internal {
        if (key == bytes32(0) || bytes(name).length == 0) revert NoSuchCategory();
        if (baseBps < MIN_BPS || baseBps > MAX_BPS) revert InvalidRate();
        if (bytes(categories[key].name).length == 0) _categoryList.push(key);
        categories[key] = Category(name, baseBps, active);
        emit CategorySet(key, name, baseBps, active);
    }

    // ---------------------------------------------------------------------
    // Shop bond: a partner backs its stamp with money
    // ---------------------------------------------------------------------

    function stakeBond() external payable {
        (, , bool active, , , , ) = passport.partners(msg.sender);
        if (!active) revert NotPartner();
        if (msg.value == 0) revert WrongAmount();
        bondOf[msg.sender] += msg.value;
        emit BondStaked(msg.sender, msg.value, bondOf[msg.sender]);
    }

    /// @notice Take back bond that is not held behind a live cover.
    function withdrawBond(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > bondOf[msg.sender] - bondLocked[msg.sender]) revert FundsLocked();
        bondOf[msg.sender] -= amount;
        emit BondWithdrawn(msg.sender, amount, bondOf[msg.sender]);
        _pay(msg.sender, amount);
    }

    function freeBond(address shop) public view returns (uint256) { return bondOf[shop] - bondLocked[shop]; }

    // ---------------------------------------------------------------------
    // Pool: members fund the cover and earn the fees
    // ---------------------------------------------------------------------

    function depositToPool() external payable returns (uint256 shares) {
        (, , , , bool active) = passport.members(msg.sender);
        if (!active) revert NotMember();
        if (msg.value == 0) revert WrongAmount();
        shares = totalShares == 0 || poolAssets == 0 ? msg.value : (msg.value * totalShares) / poolAssets;
        if (shares == 0) revert WrongAmount();
        totalShares += shares;
        sharesOf[msg.sender] += shares;
        poolAssets += msg.value;
        emit PoolDeposit(msg.sender, msg.value, shares);
    }

    /// @notice Cash in pool shares at today's value. Money held behind live covers can't leave.
    function withdrawFromPool(uint256 shares) external nonReentrant returns (uint256 amount) {
        if (shares == 0 || shares > sharesOf[msg.sender]) revert WrongAmount();
        amount = (shares * poolAssets) / totalShares;
        if (amount > poolAssets - poolLocked) revert FundsLocked();
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        poolAssets -= amount;
        emit PoolWithdrawal(msg.sender, amount, shares);
        _pay(msg.sender, amount);
    }

    function freePool() public view returns (uint256) { return poolAssets - poolLocked; }

    /// @notice What a member's pool shares are worth right now.
    function stakeValue(address member) external view returns (uint256) {
        return totalShares == 0 ? 0 : (sharesOf[member] * poolAssets) / totalShares;
    }

    // ---------------------------------------------------------------------
    // Pricing: the fee comes from the records
    // ---------------------------------------------------------------------

    /// @notice The rating for a seller and a shop, with each part shown separately.
    ///         feeBps = category base + sellerAdj + inviterAdj + shopAdj, kept between MIN_BPS and MAX_BPS.
    function rate(address seller, address shop, bytes32 category)
        public view returns (uint16 feeBps, int256 base, int256 sellerAdj, int256 inviterAdj, int256 shopAdj)
    {
        base = categories[category].baseBps;
        if (base == 0) revert NoSuchCategory();

        (uint32 sold, , uint32 refundsGiven, , uint32 disputesLost, , , ) = passport.records(seller);
        if (sold == 0) sellerAdj += NEW_SELLER_LOADING;
        int256 credit = int256(uint256(sold)) * SALE_CREDIT;
        sellerAdj -= credit > MAX_SALE_CREDIT ? MAX_SALE_CREDIT : credit;
        sellerAdj += int256(uint256(disputesLost)) * DISPUTE_LOST_LOADING;
        sellerAdj += int256(uint256(refundsGiven)) * REFUND_LOADING;
        sellerAdj += int256(uint256(fakesSoldBy[seller])) * SELLER_FAKE_LOADING;

        (address inviter, , , , ) = passport.members(seller);
        if (inviter != address(0)) {
            (, , , , , , , uint32 inviteesLost) = passport.records(inviter);
            int256 load = int256(uint256(inviteesLost)) * INVITER_LOADING;
            inviterAdj = load > MAX_INVITER_LOADING ? MAX_INVITER_LOADING : load;
        }

        (, , , uint32 authenticated, , , ) = passport.partners(shop);
        // The shop's record counts in the category it's stamping in. The clean
        // credit needs a clean record everywhere.
        uint32 fakes = fakesStampedIn[shop][category];
        if (fakes > 0) shopAdj = int256(uint256(fakes)) * SHOP_FAKE_LOADING;
        else if (fakesStampedBy[shop] == 0 && authenticated >= SHOP_CLEAN_MIN_STAMPS) shopAdj = -SHOP_CLEAN_CREDIT;

        int256 total = base + sellerAdj + inviterAdj + shopAdj;
        if (total < MIN_BPS) total = MIN_BPS;
        if (total > MAX_BPS) total = MAX_BPS;
        feeBps = uint16(uint256(total));
    }

    /// @notice The cover fee for a piece that is listed or in a sale.
    function quote(uint256 itemId)
        external view
        returns (uint256 fee, uint16 feeBps, int256 base, int256 sellerAdj, int256 inviterAdj, int256 shopAdj, bool available, bytes32 category)
    {
        IWardrobePassportV3.Item memory it = passport.getItem(itemId);
        category = categoryOf[itemId];
        if (category == bytes32(0)) return (0, 0, 0, 0, 0, 0, false, category); // not certified by a specialist
        (feeBps, base, sellerAdj, inviterAdj, shopAdj) = rate(it.owner, it.authBy, category);
        fee = (it.price * feeBps) / 10000;
        (uint256 shopLock, uint256 poolLock) = _locksFor(it.price);
        available = it.authBy != address(0) && it.price > 0 && specialistIn[it.authBy][category]
            && freeBond(it.authBy) >= shopLock && freePool() + fee >= poolLock;
    }

    // ---------------------------------------------------------------------
    // Cover
    // ---------------------------------------------------------------------

    /// @notice The buyer adds cover while the marketplace still holds the money.
    ///         (Not after delivery: nobody should buy cover once they've seen the piece.)
    function buyCover(uint256 itemId) external payable returns (uint256 id) {
        IWardrobePassportV3.Item memory it = passport.getItem(itemId);
        if (it.status != 2 && it.status != 3) revert NotInSale();
        if (it.buyer != msg.sender) revert NotBuyer();
        if (it.authBy == address(0)) revert NotAuthenticated();
        bytes32 cat = categoryOf[itemId];
        if (cat == bytes32(0)) revert NotCertified();
        if (!specialistIn[it.authBy][cat]) revert NotSpecialist();
        bytes32 key = keccak256(abi.encode(itemId, msg.sender, it.paidAt));
        if (coverOfSale[key] != 0) revert AlreadyCovered();

        (uint16 feeBps, , , , ) = rate(it.owner, it.authBy, cat);
        uint256 fee = (it.price * feeBps) / 10000;
        if (msg.value != fee) revert WrongAmount();

        (uint256 shopLock, uint256 poolLock) = _locksFor(it.price);
        if (freeBond(it.authBy) < shopLock) revert ShopBondTooLow();
        poolAssets += fee;
        feesEarned += fee;
        if (freePool() < poolLock) revert PoolTooSmall();
        bondLocked[it.authBy] += shopLock;
        poolLocked += poolLock;
        stampsCovered[it.authBy]++;

        id = ++coverCount;
        coverOfSale[key] = id;
        Cover storage c = _covers[id];
        c.itemId = itemId;
        c.buyer = msg.sender;
        c.seller = it.owner;
        c.shop = it.authBy;
        c.category = cat;
        c.amount = it.price;
        c.fee = fee;
        c.feeBps = feeBps;
        c.paidAt = it.paidAt;
        c.boughtAt = uint64(block.timestamp);
        c.shopLock = shopLock;
        c.poolLock = poolLock;
        emit CoverBought(id, itemId, msg.sender, it.owner, it.authBy, cat, it.price, fee, feeBps);
    }

    /// @notice Start the 90 days once the sale has completed. Anyone can call.
    function activate(uint256 id) public {
        Cover storage c = _cover(id);
        if (c.state != State.Pending) revert WrongState();
        uint64 at = _deliveredAt(c);
        if (at == 0) revert NotDelivered();
        c.deliveredAt = at;
        c.state = State.Active;
        emit CoverActivated(id, at, at + COVER_WINDOW);
    }

    /// @notice If the sale never completed (refund, cancelled, buyer won the
    ///         dispute), the cover is cancelled and the fee comes back.
    function voidCover(uint256 id) external nonReentrant {
        Cover storage c = _cover(id);
        if (c.state != State.Pending) revert WrongState();
        IWardrobePassportV3.Item memory it = passport.getItem(c.itemId);
        if (it.buyer == c.buyer && it.paidAt == c.paidAt) revert StillInSale();
        if (_deliveredAt(c) != 0) revert WrongState(); // it completed: activate instead
        c.state = State.Void;
        _release(c);
        poolAssets -= c.fee;
        feesEarned -= c.fee;
        emit CoverVoided(id, c.fee);
        _pay(c.buyer, c.fee);
    }

    /// @notice After 90 days with no claim, free the money held behind the cover.
    function expire(uint256 id) public {
        Cover storage c = _cover(id);
        if (c.state == State.Pending) activate(id);
        if (c.state != State.Active) revert WrongState();
        if (block.timestamp <= uint256(c.deliveredAt) + COVER_WINDOW) revert NotExpired();
        c.state = State.Expired;
        _release(c);
        emit CoverExpired(id);
    }

    function expireMany(uint256[] calldata ids) external {
        for (uint256 i; i < ids.length; i++) expire(ids[i]);
    }

    // ---------------------------------------------------------------------
    // Claims: a second shop re-inspects
    // ---------------------------------------------------------------------

    /// @notice The buyer says the piece is fake, within 90 days of delivery, and
    ///         posts a 5% deposit. They must still own the piece.
    function fileClaim(uint256 id, string calldata evidence) external payable {
        Cover storage c = _cover(id);
        if (c.buyer != msg.sender) revert NotBuyer();
        if (c.state == State.Pending) activate(id);
        if (c.state != State.Active) revert WrongState();
        if (block.timestamp > uint256(c.deliveredAt) + COVER_WINDOW) revert CoverEnded();
        IWardrobePassportV3.Item memory it = passport.getItem(c.itemId);
        if (it.owner != msg.sender || it.status != 0) revert NoLongerOwner();
        if (msg.value != (c.amount * CLAIM_DEPOSIT_BPS) / 10000) revert WrongAmount();
        c.state = State.Claimed;
        c.claimedAt = uint64(block.timestamp);
        c.claimDeposit = msg.value;
        c.evidence = evidence;
        emit ClaimFiled(id, msg.sender, msg.value, evidence);
    }

    /// @notice A different partner, a specialist in the same category, re-inspects the piece and rules.
    ///         If nobody rules within 3 days, the platform admin may.
    ///         Fake: the first shop's bond pays half, the pool pays half, the
    ///         buyer gets the full price back plus the deposit.
    ///         Genuine: the deposit pays the reviewer and the rest goes to the pool.
    function decideClaim(uint256 id, bool fake, string calldata ruling) external nonReentrant {
        Cover storage c = _cover(id);
        if (c.state != State.Claimed) revert WrongState();
        if (!_canReview(c, msg.sender)) revert NotReviewer();
        c.reviewer = msg.sender;
        c.ruling = ruling;
        emit ClaimDecided(id, msg.sender, fake, ruling);

        uint256 reviewFee = (c.amount * REVIEW_FEE_BPS) / 10000;
        if (fake) {
            c.state = State.Paid;
            uint256 fromBond = c.shopLock;          // includes the review fee
            uint256 fromPool = c.poolLock;
            bondLocked[c.shop] -= fromBond;
            bondOf[c.shop] -= fromBond;
            poolLocked -= fromPool;
            poolAssets -= fromPool;
            claimsPaid += fromBond - reviewFee + fromPool;
            fakesStampedBy[c.shop]++;
            fakesStampedIn[c.shop][c.category]++;
            fakesSoldBy[c.seller]++;
            emit ClaimPaid(id, c.buyer, fromBond - reviewFee, fromPool);
            _pay(c.buyer, fromBond - reviewFee + fromPool + c.claimDeposit);
            _pay(msg.sender, reviewFee);
        } else {
            c.state = State.Rejected;
            _release(c);
            claimsRejectedOf[c.buyer]++;
            poolAssets += c.claimDeposit - reviewFee;
            _pay(msg.sender, reviewFee);
        }
    }

    /// @notice Collect money from a payout that could not be sent directly.
    function withdraw() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Reading
    // ---------------------------------------------------------------------

    function getCover(uint256 id) external view returns (Cover memory) { return _cover(id); }

    function coverFor(uint256 itemId, address buyer, uint64 paidAt) external view returns (uint256) {
        return coverOfSale[keccak256(abi.encode(itemId, buyer, paidAt))];
    }

    /// @return assets money in the pool; locked held behind live covers (the most the pool could lose);
    ///         free what stakers could withdraw; fees earned so far; claims paid so far (bond + pool).
    function poolStats() external view returns (uint256 assets, uint256 locked, uint256 free, uint256 fees, uint256 paid, uint256 shares) {
        return (poolAssets, poolLocked, poolAssets - poolLocked, feesEarned, claimsPaid, totalShares);
    }

    function shopStats(address shop) external view returns (uint256 bond, uint256 locked, uint256 free, uint32 covered, uint32 fakes) {
        return (bondOf[shop], bondLocked[shop], bondOf[shop] - bondLocked[shop], stampsCovered[shop], fakesStampedBy[shop]);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _cover(uint256 id) internal view returns (Cover storage c) {
        if (id == 0 || id > coverCount) revert NoSuchCover();
        c = _covers[id];
    }

    /// @dev The shop's bond stands behind half the price plus the cost of a
    ///      re-inspection; the pool stands behind the other half.
    function _locksFor(uint256 price) internal pure returns (uint256 shopLock, uint256 poolLock) {
        uint256 half = (price * SHOP_SHARE_BPS) / 10000;
        shopLock = half + (price * REVIEW_FEE_BPS) / 10000;
        poolLock = price - half;
    }

    function _release(Cover storage c) internal {
        bondLocked[c.shop] -= c.shopLock;
        poolLocked -= c.poolLock;
    }

    /// @dev When the covered sale completed, read from the passport's own history. 0 = not yet.
    function _deliveredAt(Cover storage c) internal view returns (uint64) {
        IWardrobePassportV3.Transfer[] memory h = passport.getHistory(c.itemId);
        for (uint256 i = h.length; i > 0; i--) {
            IWardrobePassportV3.Transfer memory t = h[i - 1];
            if (t.at < c.paidAt) break;
            if (t.from == c.seller && t.to == c.buyer && t.price == c.amount) return t.at;
        }
        return 0;
    }

    function _canReview(Cover storage c, address who) internal view returns (bool) {
        if (who == c.shop || who == c.buyer || who == c.seller) return false;
        (, , bool active, , , , ) = passport.partners(who);
        if (active && specialistIn[who][c.category]) return true; // a specialist in the same category
        return who == passport.admin() && block.timestamp > uint256(c.claimedAt) + REVIEW_WINDOW;
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) {
            owed[to] += amount;
            emit PayoutDeferred(to, amount);
        }
    }
}
