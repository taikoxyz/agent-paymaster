// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {SingletonPaymasterV7} from "./pimlico/SingletonPaymasterV7.sol";

/// @title ServoPaymaster
/// @author Agent Paymaster
/// @notice Thin wrapper over Pimlico's audited SingletonPaymasterV7 that adds an ERC-20 sweep for the treasury.
/// @dev The paymaster itself is the pooled treasury for Servo: the off-chain signer sets
/// `treasury = address(this)` in every quote, and the admin uses `withdrawToken` to sweep accumulated USDC.
/// @custom:security-contact security@agent-paymaster.dev
contract ServoPaymaster is SingletonPaymasterV7 {
    using SafeERC20 for IERC20;

    error InvalidRecipient();

    constructor(address _entryPoint, address _owner, address _manager, address[] memory _signers)
        SingletonPaymasterV7(_entryPoint, _owner, _manager, _signers)
    {}

    /// @notice Sweeps ERC-20 tokens held by the paymaster to an arbitrary recipient.
    /// @dev Restricted to the admin role. Servo signs quotes with `treasury = address(this)`, so collected USDC
    /// accumulates on this contract and is swept out by operators via this function.
    /// @param _token Token to sweep.
    /// @param _to Recipient of the withdrawal.
    /// @param _amount Amount to sweep in token base units.
    function withdrawToken(address _token, address _to, uint256 _amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_to == address(0)) {
            revert InvalidRecipient();
        }

        IERC20(_token).safeTransfer(_to, _amount);
    }

    /// @notice Disables Pimlico's extra unused-gas penalty overlay for Servo-sponsored ops.
    /// @dev EntryPoint still enforces its native unused-gas penalty. Servo intentionally bills only
    /// actual gas cost plus the configured `postOpGas` buffer so token settlement stays predictable.
    function _expectedPenaltyGasCost(uint256, uint256, uint128, uint256, uint256)
        public
        pure
        override
        returns (uint256)
    {
        return 0;
    }
}
