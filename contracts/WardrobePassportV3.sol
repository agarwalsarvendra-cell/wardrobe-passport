// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title Wardrobe Passport V3: a closed community marketplace
/// @notice Every item gets a digital passport. Only invited members can trade,
///         and only members whose ID a partner pawn shop has checked in person
///         can sell. Disputes are decided by a panel of community members.
///
///         How a sale works:
///         1. A verified member lists a piece behind a partner and locks a deposit.
///         2. A member buys. The contract holds the money.
///         3. The seller marks it shipped.
///         4. The buyer confirms, or opens a dispute by posting a small bond.
///            If the buyer is silent for 7 days, the seller can collect.
///         5. A dispute goes to a panel of up to 5 verified members, drawn at
///            random. They never include the buyer, the seller, the people who
///            invited them, or the partner. The partner files an inspection
///            report as evidence. The first side to win a majority of the panel
///            wins. Members who voted with the majority share a reward.
///         6. If the panel is too small, splits evenly, or fewer than 3 vote in
///            48 hours, the partner decides.
///
///         The contract keeps a public track record for every address, including
///         how the people each member invited have behaved.
/// @dev Built for Arc, where USDC is the native currency (18 decimals).
contract WardrobePassportV3 {
    // ---------------------------------------------------------------------
    // Data
    // ---------------------------------------------------------------------

    enum Status { Owned, Listed, Paid, Shipped, Disputed }

    struct Item {
        string name;
        string brand;
        string details;
        string imageUrl;
        address owner;
        address buyer;
        address partner;      // partner standing behind the current listing
        address authBy;       // partner who authenticated the piece (0 = nobody)
        uint256 price;
        uint256 deposit;
        uint64 paidAt;
        uint64 shippedAt;
        uint64 authAt;
        Status status;
        string authNote;
        uint256 disputeId;    // open dispute (0 = none)
    }

    struct Transfer { address from; address to; uint256 price; uint64 at; }

    struct Partner {
        string name;
        string city;
        bool active;
        uint32 authenticated;
        uint32 disputesResolved; // disputes the partner had to decide itself
        uint32 reportsFiled;     // inspection reports filed for a panel
        uint32 membersVerified;  // members whose ID it checked
    }

    struct Member {
        address invitedBy;   // 0 for founding members
        address verifiedBy;  // partner that checked their ID (0 = not yet)
        uint64 joinedAt;
        uint64 verifiedAt;
        bool active;
    }

    struct Record {
        uint32 sold;
        uint32 bought;
        uint32 refundsGiven;
        uint32 disputesWon;
        uint32 disputesLost;
        uint32 votesCast;
        uint32 votesWithMajority;
        uint32 inviteesDisputesLost; // disputes lost by people this member invited
    }

    struct Dispute {
        uint256 itemId;
        address buyer;
        address seller;
        address partner;
        uint256 bond;
        uint64 openedAt;
        uint64 deadline;
        uint8 votesBuyer;
        uint8 votesSeller;
        bool resolved;
        bool buyerWon;
        bool decidedByPanel;
        string reason;
        string report;       // partner's inspection report
    }

    uint64 public constant SHIP_WINDOW = 5 days;
    uint64 public constant CONFIRM_WINDOW = 7 days;
    uint64 public constant VOTE_WINDOW = 2 days;
    uint256 public constant DEPOSIT_BPS = 1000;       // seller deposit: 10% of price
    uint256 public constant BOND_BPS = 500;           // buyer dispute bond: 5% of price
    uint256 public constant PARTNER_FEE_BPS = 300;    // partner: 3% of price
    uint256 public constant PANEL_FEE_BPS = 200;      // panel reward: 2% of price, paid by the losing side
    uint256 public constant PANEL_SIZE = 5;
    uint256 public constant MIN_PANEL = 3;            // smaller panels hand the decision to the partner
    uint256 public constant QUORUM = 3;               // votes needed to decide after the window closes
    uint256 public constant NEW_MEMBER_BUY_CAP = 50e18; // $50 until a member's ID is checked
    uint256 private constant MAX_SCAN = 200;          // bound on the panel draw loop

    address public immutable admin;

    uint256 public itemCount;
    uint256 public disputeCount;
    mapping(uint256 => Item) private _items;
    mapping(uint256 => Transfer[]) private _history;
    mapping(uint256 => Dispute) private _disputes;
    mapping(uint256 => address[]) private _panels;
    mapping(uint256 => mapping(address => uint8)) public voteOf; // 0 none, 1 buyer, 2 seller

    mapping(address => Partner) public partners;
    address[] private _partnerList;
    mapping(address => bool) public operators;  // platform accounts that register invited members
    mapping(address => Member) public members;
    address[] private _memberList;
    address[] private _verifiedList;
    mapping(address => Record) public records;
    mapping(address => uint256) public owed;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event OperatorSet(address indexed operator, bool allowed);
    event PartnerAdded(address indexed partner, string name, string city);
    event PartnerStatusChanged(address indexed partner, bool active);
    event MemberJoined(address indexed member, address indexed invitedBy);
    event MemberVerified(address indexed member, address indexed partner);
    event MemberStatusChanged(address indexed member, bool active);
    event PassportCreated(uint256 indexed id, address indexed owner, string name, string brand);
    event Authenticated(uint256 indexed id, address indexed partner, string note);
    event Listed(uint256 indexed id, uint256 price, uint256 deposit, address indexed partner);
    event ListingCancelled(uint256 indexed id);
    event Purchased(uint256 indexed id, address indexed buyer, uint256 price);
    event Shipped(uint256 indexed id);
    event SaleCompleted(uint256 indexed id, address indexed from, address indexed to, uint256 price, uint256 partnerFee);
    event Refunded(uint256 indexed id, address indexed buyer, uint256 amount);
    event DepositForfeited(uint256 indexed id, address indexed seller, uint256 amount);
    event DisputeOpened(uint256 indexed disputeId, uint256 indexed id, address indexed buyer, uint256 bond, string reason);
    event PanelDrawn(uint256 indexed disputeId, address[] panel);
    event ReportFiled(uint256 indexed disputeId, address indexed partner, string report);
    event VoteCast(uint256 indexed disputeId, address indexed voter, bool buyerWins);
    event DisputeResolved(uint256 indexed disputeId, uint256 indexed id, bool buyerWins, bool byPanel, address decidedBy);
    event PanelRewarded(uint256 indexed disputeId, address indexed voter, uint256 amount);
    event PayoutDeferred(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotAdmin();
    error NotOperator();
    error NotOwner();
    error NotBuyer();
    error NotPartner();
    error NotMember();
    error NotVerified();
    error NotOnPanel();
    error AlreadyMember();
    error AlreadyVerified();
    error AlreadyVoted();
    error InvalidInviter();
    error WrongStatus();
    error WrongAmount();
    error InvalidPrice();
    error InvalidPartner();
    error PartnerExists();
    error ConflictOfInterest();
    error CannotBuyOwnItem();
    error OverNewMemberCap();
    error TooEarly();
    error TooLate();
    error PanelDecides();
    error PartnerDecides();
    error NothingOwed();
    error TransferFailed();
    error NoSuchItem();
    error NoSuchDispute();

    constructor() {
        admin = msg.sender;
        operators[msg.sender] = true;
    }

    modifier onlyAdmin() { if (msg.sender != admin) revert NotAdmin(); _; }

    // ---------------------------------------------------------------------
    // Platform: operators and partners (admin)
    // ---------------------------------------------------------------------

    /// @notice Let a platform account (e.g. the app's server wallet) register invited members.
    function setOperator(address operator, bool allowed) external onlyAdmin {
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function addPartner(address partner, string calldata name, string calldata city) external onlyAdmin {
        if (partner == address(0)) revert InvalidPartner();
        if (bytes(partners[partner].name).length != 0) revert PartnerExists();
        partners[partner] = Partner(name, city, true, 0, 0, 0, 0);
        _partnerList.push(partner);
        emit PartnerAdded(partner, name, city);
    }

    function setPartnerActive(address partner, bool active) external onlyAdmin {
        if (bytes(partners[partner].name).length == 0) revert InvalidPartner();
        partners[partner].active = active;
        emit PartnerStatusChanged(partner, active);
    }

    // ---------------------------------------------------------------------
    // Membership
    // ---------------------------------------------------------------------

    /// @notice Add an invited member. inviter = 0 for a founding member.
    function registerMember(address member, address inviter) external {
        if (!operators[msg.sender]) revert NotOperator();
        if (member == address(0)) revert InvalidInviter();
        if (members[member].joinedAt != 0) revert AlreadyMember();
        if (inviter != address(0) && (!members[inviter].active || inviter == member)) revert InvalidInviter();
        members[member] = Member(inviter, address(0), uint64(block.timestamp), 0, true);
        _memberList.push(member);
        emit MemberJoined(member, inviter);
    }

    /// @notice A partner checks a member's photo ID in person. Unlocks selling and panel duty.
    function verifyMember(address member) external {
        if (!partners[msg.sender].active) revert NotPartner();
        if (member == msg.sender) revert ConflictOfInterest();
        Member storage m = members[member];
        if (!m.active) revert NotMember();
        if (m.verifiedBy != address(0)) revert AlreadyVerified();
        m.verifiedBy = msg.sender;
        m.verifiedAt = uint64(block.timestamp);
        _verifiedList.push(member);
        partners[msg.sender].membersVerified++;
        emit MemberVerified(member, msg.sender);
    }

    /// @notice Suspend or restore a member. Suspended members can't trade or sit on panels.
    function setMemberActive(address member, bool active) external onlyAdmin {
        if (members[member].joinedAt == 0) revert NotMember();
        members[member].active = active;
        emit MemberStatusChanged(member, active);
    }

    function isVerified(address a) public view returns (bool) {
        return members[a].active && members[a].verifiedBy != address(0);
    }

    // ---------------------------------------------------------------------
    // Passports and authentication
    // ---------------------------------------------------------------------

    function createPassport(string calldata name, string calldata brand, string calldata details, string calldata imageUrl)
        external returns (uint256 id)
    {
        if (!members[msg.sender].active) revert NotMember();
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
    // Selling and buying
    // ---------------------------------------------------------------------

    function depositFor(uint256 price) public pure returns (uint256) { return (price * DEPOSIT_BPS) / 10000; }
    function bondFor(uint256 price) public pure returns (uint256) { return (price * BOND_BPS) / 10000; }

    function listForSale(uint256 id, uint256 price, address partner) external payable {
        if (!isVerified(msg.sender)) revert NotVerified();
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

    function cancelListing(uint256 id) external {
        Item storage it = _item(id);
        if (it.owner != msg.sender) revert NotOwner();
        if (it.status != Status.Listed) revert WrongStatus();
        uint256 deposit = it.deposit;
        _clearSale(it);
        emit ListingCancelled(id);
        _pay(msg.sender, deposit);
    }

    function buy(uint256 id) external payable {
        Member storage m = members[msg.sender];
        if (!m.active) revert NotMember();
        Item storage it = _item(id);
        if (it.status != Status.Listed) revert WrongStatus();
        if (it.owner == msg.sender) revert CannotBuyOwnItem();
        if (it.partner == msg.sender) revert ConflictOfInterest();
        if (msg.value != it.price) revert WrongAmount();
        if (m.verifiedBy == address(0) && it.price > NEW_MEMBER_BUY_CAP) revert OverNewMemberCap();
        it.buyer = msg.sender;
        it.paidAt = uint64(block.timestamp);
        it.status = Status.Paid;
        emit Purchased(id, msg.sender, msg.value);
    }

    function markShipped(uint256 id) external {
        Item storage it = _item(id);
        if (it.owner != msg.sender) revert NotOwner();
        if (it.status != Status.Paid) revert WrongStatus();
        it.shippedAt = uint64(block.timestamp);
        it.status = Status.Shipped;
        emit Shipped(id);
    }

    function confirmDelivery(uint256 id) external {
        Item storage it = _item(id);
        if (it.status != Status.Paid && it.status != Status.Shipped) revert WrongStatus();
        if (it.buyer != msg.sender) revert NotBuyer();
        _complete(id, it, 0);
    }

    function sellerClaim(uint256 id) external {
        Item storage it = _item(id);
        if (it.status != Status.Shipped) revert WrongStatus();
        if (it.owner != msg.sender) revert NotOwner();
        if (block.timestamp < uint256(it.shippedAt) + CONFIRM_WINDOW) revert TooEarly();
        _complete(id, it, 0);
    }

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

    // ---------------------------------------------------------------------
    // Disputes: community panel
    // ---------------------------------------------------------------------

    /// @notice Buyer opens a dispute after shipping, posting a bond of 5% of the price.
    ///         The bond comes back if the buyer wins; it pays the panel and the
    ///         seller if the buyer loses. A panel is drawn straight away.
    function openDispute(uint256 id, string calldata reason) external payable returns (uint256 did) {
        Item storage it = _item(id);
        if (it.status != Status.Shipped) revert WrongStatus();
        if (it.buyer != msg.sender) revert NotBuyer();
        if (msg.value != bondFor(it.price)) revert WrongAmount();

        did = ++disputeCount;
        Dispute storage d = _disputes[did];
        d.itemId = id;
        d.buyer = msg.sender;
        d.seller = it.owner;
        d.partner = it.partner;
        d.bond = msg.value;
        d.openedAt = uint64(block.timestamp);
        d.deadline = uint64(block.timestamp + VOTE_WINDOW);
        d.reason = reason;
        it.status = Status.Disputed;
        it.disputeId = did;

        _drawPanel(did, d);
        emit DisputeOpened(did, id, msg.sender, msg.value, reason);
        emit PanelDrawn(did, _panels[did]);
    }

    /// @notice The partner behind the sale files its inspection report as evidence.
    function fileReport(uint256 did, string calldata report) external {
        Dispute storage d = _dispute(did);
        if (msg.sender != d.partner) revert NotPartner();
        if (d.resolved) revert WrongStatus();
        if (bytes(d.report).length == 0) partners[msg.sender].reportsFiled++;
        d.report = report;
        emit ReportFiled(did, msg.sender, report);
    }

    /// @notice A panel member votes. The first side to reach a majority of the
    ///         panel wins at once.
    function castVote(uint256 did, bool buyerWins) external {
        Dispute storage d = _dispute(did);
        if (d.resolved) revert WrongStatus();
        if (block.timestamp > d.deadline) revert TooLate();
        if (!_onPanel(did, msg.sender)) revert NotOnPanel();
        if (voteOf[did][msg.sender] != 0) revert AlreadyVoted();

        voteOf[did][msg.sender] = buyerWins ? 1 : 2;
        records[msg.sender].votesCast++;
        if (buyerWins) d.votesBuyer++; else d.votesSeller++;
        emit VoteCast(did, msg.sender, buyerWins);

        uint256 n = _panels[did].length;
        if (n >= MIN_PANEL) {
            uint256 majority = n / 2 + 1;
            if (d.votesBuyer >= majority) _settle(did, d, true, true);
            else if (d.votesSeller >= majority) _settle(did, d, false, true);
        }
    }

    /// @notice After the vote window, anyone can close a dispute that reached
    ///         quorum with a clear winner.
    function finalizeDispute(uint256 did) external {
        Dispute storage d = _dispute(did);
        if (d.resolved) revert WrongStatus();
        if (block.timestamp <= d.deadline) revert TooEarly();
        if (!_panelCanDecide(did, d)) revert PartnerDecides();
        _settle(did, d, d.votesBuyer > d.votesSeller, true);
    }

    /// @notice The partner decides when the panel can't: too few eligible
    ///         members, or after the window with fewer than 3 votes or a tie.
    ///         The admin can step in if the partner doesn't.
    function resolveDispute(uint256 did, bool buyerWins) external {
        Dispute storage d = _dispute(did);
        if (d.resolved) revert WrongStatus();
        if (msg.sender != d.partner && msg.sender != admin) revert NotPartner();
        if (_panels[did].length >= MIN_PANEL) {
            if (block.timestamp <= d.deadline) revert PanelDecides();
            if (_panelCanDecide(did, d)) revert PanelDecides();
        }
        if (msg.sender == d.partner) partners[msg.sender].disputesResolved++;
        _settle(did, d, buyerWins, false);
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

    function getItem(uint256 id) external view returns (Item memory) { return _item(id); }
    function getHistory(uint256 id) external view returns (Transfer[] memory) { _item(id); return _history[id]; }
    function getDispute(uint256 did) external view returns (Dispute memory) { return _dispute(did); }
    function getPanel(uint256 did) external view returns (address[] memory) { _dispute(did); return _panels[did]; }
    function getPartners() external view returns (address[] memory) { return _partnerList; }
    function getMembers() external view returns (address[] memory) { return _memberList; }
    function getVerifiedMembers() external view returns (address[] memory) { return _verifiedList; }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _item(uint256 id) internal view returns (Item storage it) {
        if (id == 0 || id > itemCount) revert NoSuchItem();
        it = _items[id];
    }

    function _dispute(uint256 did) internal view returns (Dispute storage d) {
        if (did == 0 || did > disputeCount) revert NoSuchDispute();
        d = _disputes[did];
    }

    function _onPanel(uint256 did, address a) internal view returns (bool) {
        address[] storage p = _panels[did];
        for (uint256 i; i < p.length; i++) if (p[i] == a) return true;
        return false;
    }

    function _panelCanDecide(uint256 did, Dispute storage d) internal view returns (bool) {
        return _panels[did].length >= MIN_PANEL
            && uint256(d.votesBuyer) + d.votesSeller >= QUORUM
            && d.votesBuyer != d.votesSeller;
    }

    /// @dev Pick up to PANEL_SIZE active, ID-verified members, starting at a
    ///      hashed point in the member list. Excludes the buyer, the seller,
    ///      whoever invited either of them, and any partner.
    ///      The seed uses only the dispute's own data, not block data, so the
    ///      gas a wallet estimates is exactly the gas the draw uses. (With block
    ///      data, the draw at estimation time can differ from the real one and
    ///      run out of gas.) Production would use a VRF or commit-reveal so
    ///      nobody can predict the panel.
    function _drawPanel(uint256 did, Dispute storage d) internal {
        uint256 n = _verifiedList.length;
        if (n == 0) return;
        address bInv = members[d.buyer].invitedBy;
        address sInv = members[d.seller].invitedBy;
        uint256 start = uint256(keccak256(abi.encode(did, d.itemId, d.buyer, d.seller, n))) % n;
        uint256 scan = n < MAX_SCAN ? n : MAX_SCAN;
        address[] storage panel = _panels[did];
        for (uint256 k; k < scan && panel.length < PANEL_SIZE; k++) {
            address c = _verifiedList[(start + k) % n];
            if (c == d.buyer || c == d.seller || c == bInv || c == sInv) continue;
            if (!members[c].active || bytes(partners[c].name).length != 0) continue;
            panel.push(c);
        }
    }

    function _settle(uint256 did, Dispute storage d, bool buyerWins, bool byPanel) internal {
        Item storage it = _items[d.itemId];
        d.resolved = true;
        d.buyerWon = buyerWins;
        d.decidedByPanel = byPanel;
        emit DisputeResolved(did, d.itemId, buyerWins, byPanel, byPanel ? address(this) : msg.sender);

        // Panel members who voted with the outcome share the panel reward,
        // paid by the losing side.
        uint256 winners = buyerWins ? d.votesBuyer : d.votesSeller;
        uint256 share = winners == 0 ? 0 : ((it.price * PANEL_FEE_BPS) / 10000) / winners;
        uint256 paidOut = share * winners;

        if (buyerWins) _buyerWins(d, it, paidOut);
        else _sellerWins(d, it, paidOut);
        _rewardPanel(did, buyerWins ? 1 : 2, share);
    }

    /// @dev The seller's deposit pays the partner and the panel; the buyer gets
    ///      the price, the bond and the rest of the deposit. The piece stays
    ///      with the seller, off sale.
    function _buyerWins(Dispute storage d, Item storage it, uint256 paidOut) internal {
        uint256 price = it.price;
        uint256 deposit = it.deposit;
        uint256 fee = (price * PARTNER_FEE_BPS) / 10000;
        _clearSale(it);
        records[d.seller].disputesLost++;
        records[d.buyer].disputesWon++;
        address inv = members[d.seller].invitedBy;
        if (inv != address(0)) records[inv].inviteesDisputesLost++;
        emit Refunded(d.itemId, d.buyer, price);
        emit DepositForfeited(d.itemId, d.seller, deposit);
        _pay(d.buyer, price + d.bond + deposit - fee - paidOut);
        _pay(d.partner, fee);
    }

    /// @dev The sale completes; the buyer's bond pays the panel and the rest
    ///      goes to the seller for the trouble.
    function _sellerWins(Dispute storage d, Item storage it, uint256 paidOut) internal {
        records[d.seller].disputesWon++;
        records[d.buyer].disputesLost++;
        address inv = members[d.buyer].invitedBy;
        if (inv != address(0)) records[inv].inviteesDisputesLost++;
        _complete(d.itemId, it, d.bond - paidOut);
    }

    function _rewardPanel(uint256 did, uint8 winSide, uint256 share) internal {
        address[] storage panel = _panels[did];
        for (uint256 i; i < panel.length; i++) {
            address v = panel[i];
            if (voteOf[did][v] == winSide) {
                records[v].votesWithMajority++;
                emit PanelRewarded(did, v, share);
                _pay(v, share);
            }
        }
    }

    function _clearSale(Item storage it) internal {
        it.buyer = address(0);
        it.partner = address(0);
        it.price = 0;
        it.deposit = 0;
        it.paidAt = 0;
        it.shippedAt = 0;
        it.disputeId = 0;
        it.status = Status.Owned;
    }

    /// @dev Pay the seller (price - fee + deposit + extra), pay the partner and
    ///      move the passport to the buyer. State first, money last.
    function _complete(uint256 id, Item storage it, uint256 extraToSeller) internal {
        address seller = it.owner;
        address buyer = it.buyer;
        address partner = it.partner;
        uint256 amount = it.price;
        uint256 deposit = it.deposit;
        uint256 fee = (amount * PARTNER_FEE_BPS) / 10000;
        _clearSale(it);
        it.owner = buyer;
        _history[id].push(Transfer(seller, buyer, amount, uint64(block.timestamp)));
        records[seller].sold++;
        records[buyer].bought++;
        emit SaleCompleted(id, seller, buyer, amount, fee);
        _pay(seller, amount - fee + deposit + extraToSeller);
        _pay(partner, fee);
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
