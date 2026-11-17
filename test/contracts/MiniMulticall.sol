// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// Local stand-in for Multicall3 (same aggregate3 and getEthBalance), placed at Multicall3's address on the test chain.
contract MiniMulticall {
    struct Call3 { address target; bool allowFailure; bytes callData; }
    struct Result { bool success; bytes returnData; }
    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory out) {
        out = new Result[](calls.length);
        for (uint256 i; i < calls.length; i++) {
            (bool ok, bytes memory ret) = calls[i].target.call(calls[i].callData);
            require(ok || calls[i].allowFailure, "Multicall3: call failed");
            out[i] = Result(ok, ret);
        }
    }
    function getEthBalance(address addr) external view returns (uint256) { return addr.balance; }
}
