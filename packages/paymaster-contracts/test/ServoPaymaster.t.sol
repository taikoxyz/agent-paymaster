// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PackedUserOperation} from "account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {ServoPaymaster} from "../src/ServoPaymaster.sol";
import {PostOpMode} from "../src/pimlico/interfaces/PostOpMode.sol";
import {BaseSingletonPaymaster} from "../src/pimlico/base/BaseSingletonPaymaster.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {MockERC20Permit} from "./mocks/MockERC20Permit.sol";

/// @notice Tests for `ServoPaymaster`, the thin wrapper over Pimlico's SingletonPaymasterV7.
/// @dev Covers ERC-20 mode happy path, signature failures, postOp settlement, treasury routing, and the
/// `withdrawToken` admin sweep. Tests drive `validatePaymasterUserOp` / `postOp` directly under
/// `vm.prank(address(entryPoint))` to avoid the account-abstraction <-> Pimlico interface type mismatch.
contract ServoPaymasterTest is Test {
    MockEntryPoint internal entryPoint;
    MockERC20Permit internal usdc;
    ServoPaymaster internal paymaster;

    address internal admin;
    address internal manager;
    uint256 internal signerKey;
    address internal signer;
    uint256 internal senderKey;
    address internal sender;
    address internal other;
    address internal receiver;

    bytes32 internal constant USER_OP_HASH = keccak256("servo-test-op");

    // Reasonable v0.7 defaults (fits within a 1 ETH cap).
    uint256 internal constant CALL_GAS_LIMIT = 120_000;
    uint256 internal constant VERIFICATION_GAS_LIMIT = 150_000;
    uint256 internal constant PRE_VERIFICATION_GAS = 30_000;
    uint128 internal constant PAYMASTER_VERIFICATION_GAS = 200_000;
    uint128 internal constant PAYMASTER_POSTOP_GAS = 50_000;
    uint256 internal constant MAX_PRIORITY_FEE = 1 gwei;
    uint256 internal constant MAX_FEE = 2 gwei;

    // Quote-time inputs: exchange rate is "tokens per 1 ETH (1e18 wei)" in USDC base units
    // (USDC has 6 decimals, so 2000 USDC/ETH = 2000 * 1e6 = 2e9).
    uint256 internal constant EXCHANGE_RATE = 2_000_000_000; // 2000 USDC per ETH
    uint128 internal constant POST_OP_GAS = 40_000;
    uint128 internal constant PAYMASTER_VALIDATION_GAS_LIMIT = 150_000;

    function setUp() public {
        admin = address(this);
        manager = makeAddr("manager");
        signerKey = 0xA11CE;
        signer = vm.addr(signerKey);
        senderKey = 0xB0B;
        sender = vm.addr(senderKey);
        other = makeAddr("other");
        receiver = makeAddr("receiver");

        entryPoint = new MockEntryPoint();
        usdc = new MockERC20Permit();

        address[] memory signers = new address[](1);
        signers[0] = signer;

        paymaster = new ServoPaymaster(address(entryPoint), admin, manager, signers);

        // Give the sender USDC and a max approval to the paymaster.
        usdc.mint(sender, 100_000_000); // 100 USDC
        vm.prank(sender);
        usdc.approve(address(paymaster), type(uint256).max);
    }

    // -------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------

    function _packAccountGasLimits(uint256 _verificationGas, uint256 _callGas) internal pure returns (bytes32) {
        return bytes32((_verificationGas << 128) | _callGas);
    }

    function _packGasFees(uint256 _maxPriority, uint256 _maxFee) internal pure returns (bytes32) {
        return bytes32((_maxPriority << 128) | _maxFee);
    }

    /// @dev Builds the ERC-20 mode paymasterConfig excluding the signature, using no optional flags.
    function _buildErc20ConfigNoSig(uint48 _validUntil, uint48 _validAfter) internal view returns (bytes memory) {
        return abi.encodePacked(
            uint8(0x00), // flags: no constantFee, no recipient, no prefund
            bytes6(_validUntil),
            bytes6(_validAfter),
            bytes20(address(usdc)),
            POST_OP_GAS,
            EXCHANGE_RATE,
            PAYMASTER_VALIDATION_GAS_LIMIT,
            bytes20(address(paymaster)) // treasury = paymaster itself (pooled)
        );
    }

    /// @dev Encodes outer [paymaster(20) | verificationGas(16) | postOpGas(16) | modeByte | erc20ConfigNoSig]
    /// for hashing. Length is exactly 170 bytes — Pimlico computes the hash over bytes [:170].
    function _assembleUnsignedPaymasterAndData(uint48 _validUntil, uint48 _validAfter)
        internal
        view
        returns (bytes memory)
    {
        bytes memory erc20ConfigNoSig = _buildErc20ConfigNoSig(_validUntil, _validAfter);
        // modeByte = (mode=1 << 1) | allowAllBundlers=1 = 0x03
        return abi.encodePacked(
            address(paymaster), PAYMASTER_VERIFICATION_GAS, PAYMASTER_POSTOP_GAS, uint8(0x03), erc20ConfigNoSig
        );
    }

    /// @dev Builds a full UserOp with signed paymasterAndData (ERC-20 mode, no prefund).
    function _buildSignedUserOp(bytes memory _callData, uint48 _validUntil, uint48 _validAfter)
        internal
        view
        returns (PackedUserOperation memory userOp)
    {
        bytes memory unsignedPmAndData = _assembleUnsignedPaymasterAndData(_validUntil, _validAfter);

        userOp = PackedUserOperation({
            sender: sender,
            nonce: 1,
            initCode: "",
            callData: _callData,
            accountGasLimits: _packAccountGasLimits(VERIFICATION_GAS_LIMIT, CALL_GAS_LIMIT),
            preVerificationGas: PRE_VERIFICATION_GAS,
            gasFees: _packGasFees(MAX_PRIORITY_FEE, MAX_FEE),
            paymasterAndData: unsignedPmAndData,
            signature: ""
        });

        bytes32 toSign = paymaster.getHash(1, userOp);
        bytes32 ethSigned = MessageHashUtils.toEthSignedMessageHash(toSign);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, ethSigned);
        bytes memory sig = abi.encodePacked(r, s, v);

        userOp.paymasterAndData = abi.encodePacked(unsignedPmAndData, sig);
    }

    // -------------------------------------------------------------
    // Access control
    // -------------------------------------------------------------

    function test_rejectsValidateFromNonEntrypoint() public {
        PackedUserOperation memory userOp =
            _buildSignedUserOp(hex"00", uint48(block.timestamp + 60), uint48(block.timestamp));

        vm.expectRevert(bytes("Sender not EntryPoint"));
        paymaster.validatePaymasterUserOp(userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_rejectsPostOpFromNonEntrypoint() public {
        bytes memory emptyContext;
        vm.expectRevert(bytes("Sender not EntryPoint"));
        paymaster.postOp(PostOpMode.opSucceeded, emptyContext, 0, 0);
    }

    // -------------------------------------------------------------
    // ERC-20 mode validation + postOp
    // -------------------------------------------------------------

    function test_validatesAndSettlesErc20ModeHappyPath() public {
        uint48 validUntil = uint48(block.timestamp + 120);
        uint48 validAfter = uint48(block.timestamp);
        PackedUserOperation memory userOp = _buildSignedUserOp(hex"1234", validUntil, validAfter);

        uint256 requiredPreFund = 0.0005 ether;

        vm.prank(address(entryPoint));
        (bytes memory context, uint256 validationData) =
            paymaster.validatePaymasterUserOp(userOp, USER_OP_HASH, requiredPreFund);

        // validation succeeds: low 160 bits (signer valid) == 0
        assertEq(validationData & uint256(type(uint160).max), 0, "signer should validate");

        // No prefund was taken because preFundInToken = 0.
        assertEq(usdc.balanceOf(address(paymaster)), 0);

        // postOp settles to treasury (= paymaster).
        uint256 actualGasCost = 0.0003 ether;
        uint256 actualFeePerGas = MAX_FEE; // bundler bills at maxFeePerGas in this test

        vm.prank(address(entryPoint));
        paymaster.postOp(PostOpMode.opSucceeded, context, actualGasCost, actualFeePerGas);

        uint256 paymasterBalance = usdc.balanceOf(address(paymaster));
        assertGt(paymasterBalance, 0, "treasury should have received USDC");

        uint256 expectedCharge = paymaster.getCostInToken(actualGasCost, POST_OP_GAS, actualFeePerGas, EXCHANGE_RATE);
        assertEq(paymasterBalance, expectedCharge, "Servo should bill only actual gas plus billed postOp gas");
    }

    function test_expectedPenaltyGasCostIsZero() public view {
        uint256 penalty = paymaster._expectedPenaltyGasCost(300_000, 2 gwei, POST_OP_GAS, 500_000, 200_000);

        assertEq(penalty, 0, "Servo should not add Pimlico's extra penalty overlay");
    }

    function test_rejectsErc20ModeWithInvalidSigner() public {
        uint48 validUntil = uint48(block.timestamp + 60);
        uint48 validAfter = uint48(block.timestamp);
        PackedUserOperation memory userOp = _buildSignedUserOp(hex"5566", validUntil, validAfter);

        // Sign with a different key to flip the signer.
        bytes memory pmd = userOp.paymasterAndData;
        bytes memory unsignedLen = new bytes(pmd.length - 65);
        for (uint256 i = 0; i < unsignedLen.length; i++) {
            unsignedLen[i] = pmd[i];
        }
        bytes32 toSign = paymaster.getHash(1, userOp);
        bytes32 ethSigned = MessageHashUtils.toEthSignedMessageHash(toSign);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xDEAD), ethSigned);
        userOp.paymasterAndData = abi.encodePacked(unsignedLen, abi.encodePacked(r, s, v));

        vm.prank(address(entryPoint));
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(userOp, USER_OP_HASH, 0.0005 ether);

        // Low byte of validationData is 1 when signer is unknown (SIG_VALIDATION_FAILED).
        assertEq(validationData & uint256(type(uint160).max), 1, "bad signer should fail validation");
    }

    function test_rejectsErc20ModeWhenTokenMissingFromConfig() public {
        // Build a config with token = address(0) — should revert with TokenAddressInvalid.
        bytes memory badConfig = abi.encodePacked(
            uint8(0x00), // flags
            bytes6(uint48(block.timestamp + 60)),
            bytes6(uint48(block.timestamp)),
            bytes20(address(0)), // bad token
            POST_OP_GAS,
            EXCHANGE_RATE,
            PAYMASTER_VALIDATION_GAS_LIMIT,
            bytes20(address(paymaster))
        );
        bytes memory unsignedPmAndData = abi.encodePacked(
            address(paymaster), PAYMASTER_VERIFICATION_GAS, PAYMASTER_POSTOP_GAS, uint8(0x03), badConfig
        );
        bytes memory padded = abi.encodePacked(unsignedPmAndData, new bytes(65)); // 65-byte sig placeholder

        PackedUserOperation memory userOp = PackedUserOperation({
            sender: sender,
            nonce: 1,
            initCode: "",
            callData: hex"77",
            accountGasLimits: _packAccountGasLimits(VERIFICATION_GAS_LIMIT, CALL_GAS_LIMIT),
            preVerificationGas: PRE_VERIFICATION_GAS,
            gasFees: _packGasFees(MAX_PRIORITY_FEE, MAX_FEE),
            paymasterAndData: padded,
            signature: ""
        });

        vm.prank(address(entryPoint));
        vm.expectRevert(BaseSingletonPaymaster.TokenAddressInvalid.selector);
        paymaster.validatePaymasterUserOp(userOp, USER_OP_HASH, 0.0005 ether);
    }

    function test_returnsValidUntilValidAfterInValidationData() public {
        uint48 validUntil = uint48(block.timestamp + 200);
        uint48 validAfter = uint48(block.timestamp + 5);
        PackedUserOperation memory userOp = _buildSignedUserOp(hex"ab", validUntil, validAfter);

        vm.prank(address(entryPoint));
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(userOp, USER_OP_HASH, 0.0005 ether);

        // validationData layout: sigAuth(20 bytes) | validUntil(6 bytes) | validAfter(6 bytes).
        uint48 decodedValidUntil = uint48(validationData >> 160);
        uint48 decodedValidAfter = uint48(validationData >> (160 + 48));
        assertEq(decodedValidUntil, validUntil);
        assertEq(decodedValidAfter, validAfter);
    }

    // -------------------------------------------------------------
    // withdrawToken admin sweep
    // -------------------------------------------------------------

    function test_adminCanWithdrawAccumulatedToken() public {
        usdc.mint(address(paymaster), 10_000_000);

        paymaster.withdrawToken(address(usdc), receiver, 10_000_000);
        assertEq(usdc.balanceOf(receiver), 10_000_000);
    }

    function test_nonAdminCannotWithdrawToken() public {
        usdc.mint(address(paymaster), 10_000_000);

        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, other, bytes32(0))
        );
        paymaster.withdrawToken(address(usdc), receiver, 1);
    }

    function test_managerCannotWithdrawTokenWithoutAdminRole() public {
        usdc.mint(address(paymaster), 10_000_000);

        vm.prank(manager);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, manager, bytes32(0))
        );
        paymaster.withdrawToken(address(usdc), receiver, 1);
    }

    function test_withdrawTokenRejectsZeroRecipient() public {
        usdc.mint(address(paymaster), 1);
        vm.expectRevert(ServoPaymaster.InvalidRecipient.selector);
        paymaster.withdrawToken(address(usdc), address(0), 1);
    }

    // -------------------------------------------------------------
    // Signer rotation
    // -------------------------------------------------------------

    function test_managerCanAddAndRemoveSigners() public {
        address newSigner = makeAddr("newSigner");

        vm.prank(manager);
        paymaster.addSigner(newSigner);
        assertTrue(paymaster.signers(newSigner));

        vm.prank(manager);
        paymaster.removeSigner(newSigner);
        assertFalse(paymaster.signers(newSigner));
    }

    function test_nonAdminOrManagerCannotRotateSigners() public {
        vm.prank(other);
        vm.expectRevert();
        paymaster.addSigner(other);
    }

    // -------------------------------------------------------------
    // EntryPoint deposit / stake via BasePaymaster
    // -------------------------------------------------------------

    function test_paymasterDepositAndWithdraw() public {
        vm.deal(address(this), 1 ether);
        paymaster.deposit{value: 0.1 ether}();
        assertEq(entryPoint.deposits(address(paymaster)), 0.1 ether);

        paymaster.withdrawTo(payable(receiver), 0.05 ether);
        assertEq(entryPoint.deposits(address(paymaster)), 0.05 ether);
    }
}
