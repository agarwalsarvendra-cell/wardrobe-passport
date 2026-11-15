// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title Wardrobe Passport V2
/// @notice Every item gets a digital passport. Sales run through verified
///         local partners (for example a pawn shop) who can authenticate a
///         piece in person and settle disputes.
///
///         How a sale works:
///         1. The seller lists a piece, picks a partner and locks a deposit.
///         2. The buyer pays. The contract holds the money.
///         3. The seller marks the piece as shipped.
///         4. The buyer confirms it arrived, or opens a dispute. If the buyer
///            does nothing for 7 days, the seller can collect.
///         5. A dispute is decided by the partner named on the listing. A
///            seller who loses a dispute loses the deposit.
///
///         The contract also keeps a track record for every address (sales,
///         purchases, refunds, disputes won and lost) that nobody can edit.
/// @dev Built for Arc, where USDC is the native currency. msg.value is in
///      native USDC units with 18 decimals (1 USDC = 1e18).
contract WardrobePassportV2 {
    // ---------------------------------------------------------------------
    // Data
    // ---------------------------------------------------------------------

    enum Status {
        Owned,    // in the owner's wardrobe
        Listed,   // for sale, deposit locked
        Paid,     // buyer has paid, money held, waiting for the seller to ship
        Shipped,  // seller says it is on its way; buyer confirms or disputes
        Disputed  // buyer opened a dispute; the partner decides
    }

    struct Item {
        string name;
        string brand;
        string details;       // size, condition, serial number...
        string imageUrl;      // small photo (data URL) or icon key
        address owner;
        address buyer;        // set while Paid / Shipped / Disputed
        address partner;      // partner standing behind the current listing
        address authBy;       // partner who authenticated the piece (0 = nobody)
        uint256 price;        // native USDC units (18 decimals)
        uint256 deposit;      // seller's locked deposit for the current listing
        uint64 paidAt;
        uint64 shippedAt;
        uint64 authAt;
        Status status;
        string authNote;      // what the partner checked
        string disputeReason; // why the buyer opened a dispute
    }

    struct Transfer {
        address from;
        address to;
        uint256 price;
        uint64 at;
    }

    struct Partner {
        string name;
        string city;
        bool active;
        uint32 authenticated;    // pieces authenticated
        uint32 disputesResolved; // disputes decided
    }

    struct Record {
        uint32 sold;
        uint32 bought;
        uint32 refundsGiven;  // sales the seller cancelled or never shipped
        uint32 disputesWon;
        uint32 disputesLost;
    }

    /// @notice Seller must ship within this time, or the buyer can cancel.
    uint64 public constant SHIP_WINDOW = 5 days;
    /// @notice After shipping, the buyer has this long to confirm or dispute.
    uint64 public constant CONFIRM_WINDOW = 7 days;
    /// @notice Seller's deposit: 10% of the price (in basis points).
    uint256 public constant DEPOSIT_BPS = 1000;
    /// @notice Partner's fee: 3% of the price (in basis points).
    uint256 public constant PARTNER_FEE_BPS = 300;

    /// @notice The account that approves partners (the deployer).
    address public immutable admin;

    uint256 public itemCount;
    mapping(uint256 => Item) private _items;
    mapping(uint256 => Transfer[]) private _history;

    mapping(address => Partner) public partners;
    address[] private _partnerList;

    mapping(address => Record) public records;

    /// @notice Money owed to someone whose direct payout failed. They collect
    ///         it with withdraw(). (Arc can reject a transfer, e.g. to a
    ///         blocklisted address, so a failed payout never locks a sale.)
    mapping(address => uint256) public owed;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event PartnerAdded(address indexed partner, string name, string city);
    event PartnerStatusChanged(address indexed partner, bool active);
    event PassportCreated(uint256 indexed id, address indexed owner, string name, string brand);
    event Authenticated(uint256 indexed id, address indexed partner, string note);
    event Listed(uint256 indexed id, uint256 price, uint256 deposit, address indexed partner);
    event ListingCancelled(uint256 indexed id);
    event Purchased(uint256 indexed id, address indexed buyer, uint256 price);
    event Shipped(uint256 indexed id);
    event SaleCompleted(uint256 indexed id, address indexed from, address indexed to, uint256 price, uint256 partnerFee);
    event Refunded(uint256 indexed id, address indexed buyer, uint256 amount);
    event DisputeOpened(uint256 indexed id, address indexed buyer, string reason);
    event DisputeResolved(uint256 indexed id, address indexed partner, bool buyerWins);
    event DepositForfeited(uint256 indexed id, address indexed seller, uint256 amount);
    event PayoutDeferred(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotAdmin();
    error NotOwner();
    error NotBuyer();
    error NotPartner();
    error WrongStatus();
    error WrongAmount();
    error InvalidPrice();
    error InvalidPartner();
    error PartnerExists();
    error ConflictOfInterest();
    error CannotBuyOwnItem();
    error TooEarly();
    error NothingOwed();
    error TransferFailed();
    error NoSuchItem();

    constructor() {
        admin = msg.sender;
    }

    // ---------------------------------------------------------------------
    // Partners (approved by the admin)
    // ---------------------------------------------------------------------

    /// @notice Approve a local partner, e.g. a pawn shop in a given city.
    function addPartner(address partner, string calldata name, string calldata city) external {
        if (msg.sender != admin) revert NotAdmin();
        if (partner == address(0)) revert InvalidPartner();
        if (bytes(partners[partner].name).length != 0) revert PartnerExists();
        partners[partner] = Partner(name, city, true, 0, 0);
        _partnerList.push(partner);
        emit PartnerAdded(partner, name, city);
    }

    /// @notice Pause or re-activate a partner. Open sales they stand behind
    ///         can still be resolved by them.
    function setPartnerActive(address partner, bool active) external {
        if (msg.sender != admin) revert NotAdmin();
        if (bytes(partners[partner].name).length == 0) revert InvalidPartner();
        partners[partner].active = active;
        emit PartnerStatusChanged(partner, active);
    }

    /// @notice A partner inspects a piece in person and stamps its passport.
    function authenticate(uint256 id, string calldata note) external {
        if (!partners[msg.sender].active) revert NotPartner();
        Item storage it = _item(id);
        if (it.owner == msg.sender) revert ConflictOfInterest();
        it.authBy = msg.sender;
        it.authAt = uint64(block.timestamp);
        it.authNote = note;
        partners[msg.sender].authenticated++;
        emit Authenticated(id, msg.sender, note);
    }

    // ---------------------------------------------------------------------
    // Owner actions
    // ---------------------------------------------------------------------

    /// @notice Add an item to your wardrobe and give it a passport.
    function createPassport(
        string calldata name,
        string calldata brand,
        string calldata details,
        string calldata imageUrl
    ) external returns (uint256 id) {
        id = ++itemCount;
        Item storage it = _items[id];
        it.name = name;
        it.brand = brand;
        it.details = details;
        it.imageUrl = imageUrl;
        it.owner = msg.sender;

        _history[id].push(Transfer(address(0), msg.sender, 0, uint64(block.timestamp)));
        emit PassportCreated(id, msg.sender, name, brand);
    }

    /// @notice The deposit a seller must lock to list at this price.
    function depositFor(uint256 price) public pure returns (uint256) {
        return (price * DEPOSIT_BPS) / 10000;
    }

    /// @notice List an item for sale behind a partner, locking the deposit.
    function listForSale(uint256 id, uint256 price, address partner) external payable {
        Item storage it = _item(id);
        if (it.owner != msg.sender) revert NotOwner();
        if (it.status != Status.Owned) revert WrongStatus();
        if (price == 0) revert InvalidPrice();
        if (!partners[partner].active) revert InvalidPartner();
        if (partner == msg.sender) revert ConflictOfInterest();
        if (msg.value != depositFor(price)) revert WrongAmount();

        it.price = price;
        it.deposit = msg.value;
        it.partner = partner;
        it.status = Status.Listed;
        emit Listed(id, price, msg.value, partner);
    }

    /// @notice Take an item off sale (before anyone has paid). Deposit returned.
    function cancelListing(uint256 id) external {
        Item storage it = _item(id);
        if (it.owner != msg.sender) revert NotOwner();
        if (it.status != Status.Listed) revert WrongStatus();

        uint256 deposit = it.deposit;
        _clearSale(it);
        emit ListingCancelled(id);
        _pay(msg.sender, deposit);
    }

    // ---------------------------------------------------------------------
    // Buying
    // ---------------------------------------------------------------------

    /// @notice Pay for a listed item. The contract holds the money.
    function buy(uint256 id) external payable {
        Item storage it = _item(id);
        if (it.status != Status.Listed) revert WrongStatus();
        if (it.owner == msg.sender) revert CannotBuyOwnItem();
        if (it.partner == msg.sender) revert ConflictOfInterest();
        if (msg.value != it.price) revert WrongAmount();

        it.buyer = msg.sender;
        it.paidAt = uint64(block.timestamp);
        it.status = Status.Paid;
        emit Purchased(id, msg.sender, msg.value);
    }

    /// @notice Seller says the piece is on its way. Starts the buyer's
    ///         7-day window to confirm or dispute.
    function markShipped(uint256 id) external {
        Item storage it = _item(id);
        if (it.owner != msg.sender) revert NotOwner();
        if (it.status != Status.Paid) revert WrongStatus();

        it.shippedAt = uint64(block.timestamp);
        it.status = Status.Shipped;
        emit Shipped(id);
    }

    /// @notice Buyer confirms the piece arrived. Seller is paid, deposit is
    ///         returned, and the passport moves to the buyer.
    function confirmDelivery(uint256 id) external {
        Item storage it = _item(id);
        if (it.status != Status.Paid && it.status != Status.Shipped) revert WrongStatus();
        if (it.buyer != msg.sender) revert NotBuyer();
        _complete(id, it);
    }

    /// @notice Buyer stayed silent for 7 days after shipping: seller collects.
    function sellerClaim(uint256 id) external {
        Item storage it = _item(id);
        if (it.status != Status.Shipped) revert WrongStatus();
        if (it.owner != msg.sender) revert NotOwner();
        if (block.timestamp < uint256(it.shippedAt) + CONFIRM_WINDOW) revert TooEarly();
        _complete(id, it);
    }

    // ---------------------------------------------------------------------
    // When things go wrong
    // ---------------------------------------------------------------------

    /// @notice Seller can't ship (before shipping): refund the buyer. The
    ///         piece goes back on sale and the refund is noted on the
    ///         seller's record.
    function sellerCancelSale(uint256 id) external {
        Item storage it = _item(id);
        if (it.status != Status.Paid) revert WrongStatus();
        if (it.owner != msg.sender) revert NotOwner();

        address buyer = it.buyer;
        uint256 amount = it.price;
        it.buyer = address(0);
        it.paidAt = 0;
        it.status = Status.Listed;
        records[msg.sender].refundsGiven++;

        emit Refunded(id, buyer, amount);
        _pay(buyer, amount);
    }

    /// @notice Seller never shipped within 5 days: the buyer cancels, gets
    ///         the money back and receives the seller's deposit.
    function buyerCancelUnshipped(uint256 id) external {
        Item storage it = _item(id);
        if (it.status != Status.Paid) revert WrongStatus();
        if (it.buyer != msg.sender) revert NotBuyer();
        if (block.timestamp < uint256(it.paidAt) + SHIP_WINDOW) revert TooEarly();

        address seller = it.owner;
        uint256 amount = it.price;
        uint256 deposit = it.deposit;
        _clearSale(it);
        records[seller].refundsGiven++;

        emit Refunded(id, msg.sender, amount);
        emit DepositForfeited(id, seller, deposit);
        _pay(msg.sender, amount + deposit);
    }

    /// @notice Buyer says something is wrong (not as described, fake, never
    ///         arrived). The partner on the listing decides.
    function openDispute(uint256 id, string calldata reason) external {
        Item storage it = _item(id);
        if (it.status != Status.Shipped) revert WrongStatus();
        if (it.buyer != msg.sender) revert NotBuyer();

        it.status = Status.Disputed;
        it.disputeReason = reason;
        emit DisputeOpened(id, msg.sender, reason);
    }

    /// @notice The partner decides a dispute.
    ///         Buyer wins: buyer is refunded and receives the seller's
    ///         deposit (minus the partner's fee). The piece stays with the
    ///         seller, off sale.
    ///         Seller wins: the sale completes as if the buyer had confirmed.
    function resolveDispute(uint256 id, bool buyerWins) external {
        Item storage it = _item(id);
        if (it.status != Status.Disputed) revert WrongStatus();
        if (it.partner != msg.sender) revert NotPartner();

        address seller = it.owner;
        address buyer = it.buyer;
        partners[msg.sender].disputesResolved++;
        emit DisputeResolved(id, msg.sender, buyerWins);

        if (!buyerWins) {
            records[seller].disputesWon++;
            records[buyer].disputesLost++;
            _complete(id, it);
            return;
        }

        uint256 amount = it.price;
        uint256 deposit = it.deposit;
        uint256 fee = _feeFor(amount);
        if (fee > deposit) fee = deposit;
        _clearSale(it);
        records[seller].disputesLost++;
        records[buyer].disputesWon++;

        emit Refunded(id, buyer, amount);
        emit DepositForfeited(id, seller, deposit);
        _pay(buyer, amount + deposit - fee);
        _pay(msg.sender, fee);
    }

    /// @notice Collect money from a payout that could not be sent directly.
    function withdraw() external {
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

    function getItem(uint256 id) external view returns (Item memory) {
        return _item(id);
    }

    /// @notice Full ownership history of an item, oldest first.
    function getHistory(uint256 id) external view returns (Transfer[] memory) {
        _item(id);
        return _history[id];
    }

    /// @notice Addresses of every partner ever approved.
    function getPartners() external view returns (address[] memory) {
        return _partnerList;
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    function _item(uint256 id) internal view returns (Item storage it) {
        if (id == 0 || id > itemCount) revert NoSuchItem();
        it = _items[id];
    }

    function _feeFor(uint256 price) internal pure returns (uint256) {
        return (price * PARTNER_FEE_BPS) / 10000;
    }

    /// @dev Reset everything about the current sale; item returns to Owned.
    function _clearSale(Item storage it) internal {
        it.buyer = address(0);
        it.partner = address(0);
        it.price = 0;
        it.deposit = 0;
        it.paidAt = 0;
        it.shippedAt = 0;
        it.disputeReason = "";
        it.status = Status.Owned;
    }

    /// @dev Pay the seller (price - fee + deposit), pay the partner's fee and
    ///      move the passport to the buyer. State first, money last.
    function _complete(uint256 id, Item storage it) internal {
        address seller = it.owner;
        address buyer = it.buyer;
        address partner = it.partner;
        uint256 amount = it.price;
        uint256 deposit = it.deposit;
        uint256 fee = _feeFor(amount);

        _clearSale(it);
        it.owner = buyer;
        _history[id].push(Transfer(seller, buyer, amount, uint64(block.timestamp)));
        records[seller].sold++;
        records[buyer].bought++;

        emit SaleCompleted(id, seller, buyer, amount, fee);
        _pay(seller, amount - fee + deposit);
        _pay(partner, fee);
    }

    /// @dev Try to pay directly. If Arc rejects the transfer, keep the money
    ///      safe in `owed` so the person can withdraw it later.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) {
            owed[to] += amount;
            emit PayoutDeferred(to, amount);
        }
    }
}
