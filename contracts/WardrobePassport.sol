// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title Wardrobe Passport
/// @notice Every item gets a digital passport. When the owner sells it, the
///         buyer's payment is held by this contract until the buyer confirms
///         the item arrived. Then the money goes to the seller and the
///         passport (ownership + history) moves to the buyer in one step.
/// @dev Built for Arc, where USDC is the native currency. msg.value is in
///      native USDC units with 18 decimals (1 USDC = 1e18).
contract WardrobePassport {
    // ---------------------------------------------------------------------
    // Data
    // ---------------------------------------------------------------------

    enum Status {
        Owned,   // sitting in the owner's wardrobe
        Listed,  // for sale, waiting for a buyer
        Pending  // buyer has paid, money is held until delivery is confirmed
    }

    struct Item {
        string name;        // e.g. "Navy wool blazer"
        string brand;       // e.g. "Hugo Boss"
        string details;     // size, condition, serial number...
        string imageUrl;    // optional photo link
        address owner;
        address buyer;      // set only while Pending
        uint256 price;      // asking price in native USDC units (18 decimals)
        uint64 paidAt;      // when the buyer paid (for the refund window)
        Status status;
    }

    struct Transfer {
        address from;
        address to;
        uint256 price;
        uint64 at;
    }

    /// @notice If the seller never ships, the buyer can take their money back
    ///         after this many seconds.
    uint64 public constant REFUND_WINDOW = 14 days;

    uint256 public itemCount;
    mapping(uint256 => Item) public items;
    mapping(uint256 => Transfer[]) private _history;

    /// @notice Money owed to someone whose direct payout failed. They can
    ///         collect it later with withdraw(). (Arc can reject a transfer,
    ///         e.g. to a blocklisted address, so we never let one failed
    ///         payout lock the whole sale.)
    mapping(address => uint256) public owed;

    // ---------------------------------------------------------------------
    // Events (these show up on the Arc explorer)
    // ---------------------------------------------------------------------

    event PassportCreated(uint256 indexed id, address indexed owner, string name, string brand);
    event Listed(uint256 indexed id, uint256 price);
    event ListingCancelled(uint256 indexed id);
    event Purchased(uint256 indexed id, address indexed buyer, uint256 price);
    event DeliveryConfirmed(uint256 indexed id, address indexed from, address indexed to, uint256 price);
    event Refunded(uint256 indexed id, address indexed buyer, uint256 amount);
    event PayoutDeferred(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotBuyer();
    error WrongStatus();
    error WrongAmount();
    error InvalidPrice();
    error CannotBuyOwnItem();
    error RefundWindowOpen();
    error NothingOwed();
    error TransferFailed();
    error NoSuchItem();

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
        Item storage it = items[id];
        it.name = name;
        it.brand = brand;
        it.details = details;
        it.imageUrl = imageUrl;
        it.owner = msg.sender;
        it.status = Status.Owned;

        // First history entry: where the passport started.
        _history[id].push(Transfer(address(0), msg.sender, 0, uint64(block.timestamp)));
        emit PassportCreated(id, msg.sender, name, brand);
    }

    /// @notice Put an item you own up for sale.
    function listForSale(uint256 id, uint256 price) external {
        Item storage it = _item(id);
        if (it.owner != msg.sender) revert NotOwner();
        if (it.status != Status.Owned) revert WrongStatus();
        if (price == 0) revert InvalidPrice();

        it.price = price;
        it.status = Status.Listed;
        emit Listed(id, price);
    }

    /// @notice Take an item off sale (only before anyone has paid).
    function cancelListing(uint256 id) external {
        Item storage it = _item(id);
        if (it.owner != msg.sender) revert NotOwner();
        if (it.status != Status.Listed) revert WrongStatus();

        it.price = 0;
        it.status = Status.Owned;
        emit ListingCancelled(id);
    }

    // ---------------------------------------------------------------------
    // Buying
    // ---------------------------------------------------------------------

    /// @notice Pay for a listed item. The money stays in this contract
    ///         until you confirm the item arrived.
    function buy(uint256 id) external payable {
        Item storage it = _item(id);
        if (it.status != Status.Listed) revert WrongStatus();
        if (it.owner == msg.sender) revert CannotBuyOwnItem();
        if (msg.value != it.price) revert WrongAmount();

        it.buyer = msg.sender;
        it.paidAt = uint64(block.timestamp);
        it.status = Status.Pending;
        emit Purchased(id, msg.sender, msg.value);
    }

    /// @notice Buyer confirms the item arrived. The seller gets paid and the
    ///         passport moves to the buyer, in the same transaction.
    function confirmDelivery(uint256 id) external {
        Item storage it = _item(id);
        if (it.status != Status.Pending) revert WrongStatus();
        if (it.buyer != msg.sender) revert NotBuyer();

        address seller = it.owner;
        uint256 amount = it.price;

        // Update everything first, then move money (safe ordering).
        it.owner = msg.sender;
        it.buyer = address(0);
        it.price = 0;
        it.paidAt = 0;
        it.status = Status.Owned;
        _history[id].push(Transfer(seller, msg.sender, amount, uint64(block.timestamp)));

        emit DeliveryConfirmed(id, seller, msg.sender, amount);
        _pay(seller, amount);
    }

    // ---------------------------------------------------------------------
    // When things go wrong
    // ---------------------------------------------------------------------

    /// @notice Seller can't ship: cancel the sale and refund the buyer.
    function sellerCancelSale(uint256 id) external {
        Item storage it = _item(id);
        if (it.status != Status.Pending) revert WrongStatus();
        if (it.owner != msg.sender) revert NotOwner();
        _refund(id, it);
    }

    /// @notice Item never arrived: after the refund window, the buyer can
    ///         take their money back without the seller's permission.
    function buyerClaimRefund(uint256 id) external {
        Item storage it = _item(id);
        if (it.status != Status.Pending) revert WrongStatus();
        if (it.buyer != msg.sender) revert NotBuyer();
        if (block.timestamp < uint256(it.paidAt) + REFUND_WINDOW) revert RefundWindowOpen();
        _refund(id, it);
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

    /// @notice Full ownership history of an item, oldest first.
    function getHistory(uint256 id) external view returns (Transfer[] memory) {
        _item(id);
        return _history[id];
    }

    /// @notice Convenience read for the app: one item with all its fields.
    function getItem(uint256 id) external view returns (Item memory) {
        return _item(id);
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    function _item(uint256 id) internal view returns (Item storage it) {
        if (id == 0 || id > itemCount) revert NoSuchItem();
        it = items[id];
    }

    function _refund(uint256 id, Item storage it) internal {
        address buyer = it.buyer;
        uint256 amount = it.price;

        it.buyer = address(0);
        it.paidAt = 0;
        it.status = Status.Listed; // back on sale at the same price

        emit Refunded(id, buyer, amount);
        _pay(buyer, amount);
    }

    /// @dev Try to pay directly. If Arc rejects the transfer, keep the money
    ///      safe in `owed` so the person can withdraw it later.
    function _pay(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) {
            owed[to] += amount;
            emit PayoutDeferred(to, amount);
        }
    }
}
