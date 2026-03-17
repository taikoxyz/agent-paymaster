// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseAccount} from "account-abstraction/contracts/core/BaseAccount.sol";
import {SIG_VALIDATION_FAILED, SIG_VALIDATION_SUCCESS} from "account-abstraction/contracts/core/Helpers.sol";
import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title ServoAccount
/// @notice Minimal Servo-native ERC-4337 account with ERC-1271 support for permit signatures.
contract ServoAccount is BaseAccount, IERC1271 {
    error InvalidEntryPoint();
    error InvalidOwner();
    error Unauthorized();
    error ArrayLengthMismatch();

    address public immutable owner;
    IEntryPoint private immutable _entryPoint;

    constructor(IEntryPoint entryPoint_, address owner_) {
        if (address(entryPoint_) == address(0)) {
            revert InvalidEntryPoint();
        }

        if (owner_ == address(0)) {
            revert InvalidOwner();
        }

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

    function executeBatch(address[] calldata targets, uint256[] calldata values, bytes[] calldata calldatas) external {
        _requireFromEntryPointOrOwner();

        uint256 length = targets.length;
        if (values.length != length || calldatas.length != length) {
            revert ArrayLengthMismatch();
        }

        for (uint256 index = 0; index < length; ++index) {
            _call(targets[index], values[index], calldatas[index]);
        }
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
        if (msg.sender != address(_entryPoint) && msg.sender != owner) {
            revert Unauthorized();
        }
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
