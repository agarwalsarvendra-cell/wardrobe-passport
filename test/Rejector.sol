// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "../contracts/WardrobePassport.sol";

/// Test helper: a seller whose wallet refuses incoming payments until switched on.
contract Rejector {
    WardrobePassport public wp;
    bool public accept;

    constructor(WardrobePassport _wp) { wp = _wp; }

    function setAccept(bool a) external { accept = a; }

    function createAndList(uint256 price) external returns (uint256 id) {
        id = wp.createPassport("Rejector jacket", "TestBrand", "M", "");
        wp.listForSale(id, price);
    }

    function doWithdraw() external { wp.withdraw(); }

    receive() external payable { require(accept, "no thanks"); }
}
