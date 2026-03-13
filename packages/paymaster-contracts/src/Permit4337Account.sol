// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseAccount} from "account-abstraction/contracts/core/BaseAccount.sol";
import {SIG_VALIDATION_FAILED, SIG_VALIDATION_SUCCESS} from "account-abstraction/contracts/core/Helpers.sol";
import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title Permit4337Account
/// @notice Minimal ERC-4337 account used for live smoke tests of the USDC paymaster flow.
/// @dev The account validates UserOperations with an EOA owner and also exposes ERC-1271 so
/// Taiko/Circle-style USDC `permit(..., bytes signature)` can authorize the paymaster.
contract Permit4337Account is BaseAccount, IERC1271 {
    address public immutable owner;
    IEntryPoint private immutable _entryPoint;

    uint256 public pingCount;

    event Ping(uint256 count);

    constructor(IEntryPoint entryPoint_, address owner_) {
        require(address(entryPoint_) != address(0), "entryPoint required");
        require(owner_ != address(0), "owner required");

        _entryPoint = entryPoint_;
        owner = owner_;
    }

    function entryPoint() public view override returns (IEntryPoint) {
        return _entryPoint;
    }

    function execute(address target, uint256 value, bytes calldata data) external {
        _requireFromEntryPointOrOwner();
        _call(target, value, data);
    }

    function ping() external {
        _requireFromEntryPointOrOwner();
        unchecked {
            pingCount += 1;
        }

        emit Ping(pingCount);
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return ECDSA.recover(hash, signature) == owner ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function _validateSignature(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) internal view override returns (uint256 validationData) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(userOpHash);

        if (ECDSA.recover(digest, userOp.signature) != owner) {
            return SIG_VALIDATION_FAILED;
        }

        return SIG_VALIDATION_SUCCESS;
    }

    function _requireFromEntryPointOrOwner() internal view {
        require(msg.sender == address(entryPoint()) || msg.sender == owner, "not owner or entry point");
    }

    function _call(address target, uint256 value, bytes memory data) internal {
        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
    }

    receive() external payable {}
}
