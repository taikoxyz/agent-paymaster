// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {ServoAccount} from "./ServoAccount.sol";

/// @title ServoAccountFactory
/// @notice Deterministic CREATE2 factory for ServoAccount deployments.
contract ServoAccountFactory {
    error InvalidEntryPoint();
    error InvalidOwner();

    event AccountCreated(address indexed account, address indexed owner, uint256 indexed salt);

    IEntryPoint public immutable entryPoint;

    constructor(IEntryPoint entryPoint_) {
        if (address(entryPoint_) == address(0)) {
            revert InvalidEntryPoint();
        }

        entryPoint = entryPoint_;
    }

    function createAccount(address owner, uint256 salt) external returns (address account) {
        if (owner == address(0)) {
            revert InvalidOwner();
        }

        account = getAddress(owner, salt);
        if (account.code.length > 0) {
            return account;
        }

        account = address(new ServoAccount{salt: bytes32(salt)}(entryPoint, owner));
        emit AccountCreated(account, owner, salt);
    }

    function getAddress(address owner, uint256 salt) public view returns (address) {
        if (owner == address(0)) {
            revert InvalidOwner();
        }

        bytes32 initCodeHash = keccak256(abi.encodePacked(type(ServoAccount).creationCode, abi.encode(entryPoint, owner)));
        return Create2.computeAddress(bytes32(salt), initCodeHash, address(this));
    }
}
