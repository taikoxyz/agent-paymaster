// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract PaymasterStub {
    address public owner;

    event Sponsored(address indexed sponsor, address indexed account, uint256 cost);

    error NotOwner();

    constructor() {
        owner = msg.sender;
    }

    function sponsor(address account, uint256 cost) external {
        if (msg.sender != owner) revert NotOwner();
        emit Sponsored(msg.sender, account, cost);
    }
}
