// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEntryPoint, IPaymaster, UserOperation} from "../interfaces/AccountAbstraction.sol";

contract MockEntryPoint is IEntryPoint {
    mapping(address => uint256) public deposits;
    mapping(address => uint256) public stakes;
    mapping(address => uint32) public unstakeDelays;

    function depositTo(address account) external payable override {
        deposits[account] += msg.value;
    }

    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external override {
        uint256 deposit = deposits[msg.sender];
        require(deposit >= withdrawAmount, "INSUFFICIENT_DEPOSIT");

        deposits[msg.sender] = deposit - withdrawAmount;
        (bool success,) = withdrawAddress.call{value: withdrawAmount}("");
        require(success, "WITHDRAW_FAILED");
    }

    function addStake(uint32 unstakeDelaySec) external payable override {
        stakes[msg.sender] += msg.value;
        unstakeDelays[msg.sender] = unstakeDelaySec;
    }

    function unlockStake() external override {}

    function withdrawStake(address payable withdrawAddress) external override {
        uint256 stake = stakes[msg.sender];
        stakes[msg.sender] = 0;

        (bool success,) = withdrawAddress.call{value: stake}("");
        require(success, "STAKE_WITHDRAW_FAILED");
    }

    function callValidatePaymaster(
        IPaymaster paymaster,
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external returns (bytes memory context, uint256 validationData) {
        return paymaster.validatePaymasterUserOp(userOp, userOpHash, maxCost);
    }

    function callPostOp(
        IPaymaster paymaster,
        IPaymaster.PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) external {
        paymaster.postOp(mode, context, actualGasCost, actualUserOpFeePerGas);
    }
}
