// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TaikoUsdcPaymaster} from "../src/TaikoUsdcPaymaster.sol";
import {IPaymaster} from "account-abstraction/contracts/interfaces/IPaymaster.sol";
import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {MockERC20Permit} from "./mocks/MockERC20Permit.sol";

contract TaikoUsdcPaymasterTest is Test {
    MockEntryPoint entryPoint;
    MockERC20Permit usdc;
    TaikoUsdcPaymaster paymaster;

    address owner;
    uint256 quoteSignerKey;
    address quoteSigner;
    address sender;
    address receiver;
    address other;

    bytes32 constant USER_OP_HASH = keccak256("user-operation-hash");

    uint256 constant DEFAULT_CALL_GAS_LIMIT = 120_000;
    uint256 constant DEFAULT_PRE_VERIFICATION_GAS = 30_000;
    uint256 constant DEFAULT_MAX_FEE_PER_GAS = 1_000_000_000;
    uint256 constant DEFAULT_MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000;
    uint128 constant DEFAULT_PAYMASTER_VALIDATION_GAS = 100_000;
    uint128 constant DEFAULT_PAYMASTER_POSTOP_GAS = 100_000;

    struct QuoteData {
        address token;
        uint256 exchangeRate;
        uint256 maxTokenCost;
        uint48 validAfter;
        uint48 validUntil;
        uint256 quoteNonce;
        uint32 postOpOverheadGas;
        uint16 surchargeBps;
    }

    struct PermitData {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function setUp() public {
        owner = address(this);
        quoteSignerKey = 0xA11CE;
        quoteSigner = vm.addr(quoteSignerKey);
        sender = makeAddr("sender");
        receiver = makeAddr("receiver");
        other = makeAddr("other");

        entryPoint = new MockEntryPoint();
        usdc = new MockERC20Permit();

        paymaster = new TaikoUsdcPaymaster(
            IEntryPoint(address(entryPoint)),
            address(usdc),
            quoteSigner,
            200_000,
            100_000,
            0.01 ether,
            120,
            1_000
        );

        usdc.mint(sender, 100_000_000);
    }

    function _packAccountGasLimits(uint256 verificationGasLimit, uint256 callGasLimit) internal pure returns (bytes32) {
        return bytes32(verificationGasLimit << 128 | callGasLimit);
    }

    function _packGasFees(uint256 maxPriorityFeePerGas, uint256 maxFeePerGas) internal pure returns (bytes32) {
        return bytes32(maxPriorityFeePerGas << 128 | maxFeePerGas);
    }

    function _emptyPermit() internal pure returns (PermitData memory) {
        return PermitData({value: 0, deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)});
    }

    function _slicePaymasterData(bytes memory paymasterAndData) internal pure returns (bytes memory paymasterData) {
        uint256 prefixLength = 20 + 16 + 16;
        paymasterData = new bytes(paymasterAndData.length - prefixLength);

        for (uint256 i = 0; i < paymasterData.length; i++) {
            paymasterData[i] = paymasterAndData[i + prefixLength];
        }
    }

    function _toContractQuote(QuoteData memory quote)
        internal
        pure
        returns (TaikoUsdcPaymaster.QuoteData memory)
    {
        return TaikoUsdcPaymaster.QuoteData({
            token: quote.token,
            exchangeRate: quote.exchangeRate,
            maxTokenCost: quote.maxTokenCost,
            validAfter: quote.validAfter,
            validUntil: quote.validUntil,
            quoteNonce: quote.quoteNonce,
            postOpOverheadGas: quote.postOpOverheadGas,
            surchargeBps: quote.surchargeBps
        });
    }

    function _signQuote(PackedUserOperation memory userOp, QuoteData memory quote) internal view returns (bytes memory) {
        bytes32 digest = paymaster.quoteHash(userOp, _toContractQuote(quote));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(quoteSignerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _buildUserOp(
        address sender_,
        bytes memory callData_,
        uint256 maxTokenCost_,
        uint256 quoteNonce_,
        uint256 verificationGasLimit_,
        uint32 postOpOverheadGas_,
        uint16 surchargeBps_,
        PermitData memory permit_
    ) internal view returns (PackedUserOperation memory userOp, QuoteData memory quote) {
        uint48 now_ = uint48(block.timestamp);

        quote = QuoteData({
            token: address(usdc),
            exchangeRate: 1_000_000,
            maxTokenCost: maxTokenCost_,
            validAfter: now_,
            validUntil: now_ + 90,
            quoteNonce: quoteNonce_,
            postOpOverheadGas: postOpOverheadGas_,
            surchargeBps: surchargeBps_
        });

        bytes memory unsignedPaymasterData = abi.encode(quote, bytes(""), permit_);

        userOp = PackedUserOperation({
            sender: sender_,
            nonce: 1,
            initCode: "",
            callData: callData_,
            accountGasLimits: _packAccountGasLimits(verificationGasLimit_, DEFAULT_CALL_GAS_LIMIT),
            preVerificationGas: DEFAULT_PRE_VERIFICATION_GAS,
            gasFees: _packGasFees(DEFAULT_MAX_PRIORITY_FEE_PER_GAS, DEFAULT_MAX_FEE_PER_GAS),
            paymasterAndData: abi.encodePacked(
                address(paymaster),
                DEFAULT_PAYMASTER_VALIDATION_GAS,
                DEFAULT_PAYMASTER_POSTOP_GAS,
                unsignedPaymasterData
            ),
            signature: ""
        });

        bytes memory sig = _signQuote(userOp, quote);
        bytes memory paymasterData = abi.encode(quote, sig, permit_);

        userOp.paymasterAndData = abi.encodePacked(
            address(paymaster),
            DEFAULT_PAYMASTER_VALIDATION_GAS,
            DEFAULT_PAYMASTER_POSTOP_GAS,
            paymasterData
        );
    }

    function _buildUserOpSimple(address sender_, bytes memory callData_, uint256 maxTokenCost_, uint256 quoteNonce_)
        internal
        view
        returns (PackedUserOperation memory, QuoteData memory)
    {
        return _buildUserOp(
            sender_,
            callData_,
            maxTokenCost_,
            quoteNonce_,
            120_000,
            0,
            0,
            _emptyPermit()
        );
    }

    function test_rejectsValidateFromNonEntrypoint() public {
        PackedUserOperation memory userOp = PackedUserOperation({
            sender: sender,
            nonce: 1,
            initCode: "",
            callData: hex"1234",
            accountGasLimits: _packAccountGasLimits(100_000, 100_000),
            preVerificationGas: 20_000,
            gasFees: _packGasFees(1, 1),
            paymasterAndData: "",
            signature: ""
        });

        vm.prank(sender);
        vm.expectRevert("Sender not EntryPoint");
        paymaster.validatePaymasterUserOp(userOp, USER_OP_HASH, 1);
    }

    function test_locksPrefundAndMarksQuoteAsUsed() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp, QuoteData memory quote) =
            _buildUserOpSimple(sender, hex"123456", maxTokenCost, 7);

        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        assertEq(usdc.balanceOf(address(paymaster)), maxTokenCost);
        bytes32 qHash = paymaster.quoteHash(userOp, _toContractQuote(quote));
        assertTrue(paymaster.usedQuoteHashes(qHash));
    }

    function test_rejectsQuoteReplay() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost * 2);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"abcd", maxTokenCost, 11);

        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        vm.expectRevert(TaikoUsdcPaymaster.QuoteAlreadyUsed.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_usesPermitWhenAllowanceMissing() public {
        uint256 maxTokenCost = 2_500_000;
        uint256 deadline = block.timestamp + 300;

        PermitData memory permit =
            PermitData({value: maxTokenCost, deadline: deadline, v: 27, r: bytes32(0), s: bytes32(0)});

        (PackedUserOperation memory userOp,) =
            _buildUserOp(sender, hex"55aa", maxTokenCost, 21, 120_000, 0, 0, permit);

        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        assertEq(usdc.balanceOf(address(paymaster)), maxTokenCost);
    }

    function test_fallsBackToAllowanceWhenPermitFails() public {
        uint256 maxTokenCost = 2_500_000;
        uint256 expiredDeadline = block.timestamp - 1;

        PermitData memory permit =
            PermitData({value: maxTokenCost, deadline: expiredDeadline, v: 27, r: bytes32(0), s: bytes32(0)});

        (PackedUserOperation memory userOp,) =
            _buildUserOp(sender, hex"90ab", maxTokenCost, 22, 120_000, 0, 0, permit);

        vm.expectRevert(TaikoUsdcPaymaster.InsufficientAllowance.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_refundsExcessUsdcInPostOp() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"6677", maxTokenCost, 31);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        uint256 actualGasCost = 0.0004 ether;

        vm.expectEmit(true, true, true, true);
        emit TaikoUsdcPaymaster.UserOperationSponsored(
            address(usdc), sender, USER_OP_HASH, 1_000_000, 400, 400, 2_999_600
        );

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opSucceeded, context, actualGasCost, 0);

        assertEq(usdc.balanceOf(address(paymaster)), 400);
    }

    function test_usesSignedQuoteTermsInPostOp() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOp(
            sender,
            hex"cc33",
            maxTokenCost,
            60,
            120_000,
            50_000,
            100,
            _emptyPermit()
        );

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        vm.expectEmit(true, true, true, true);
        emit TaikoUsdcPaymaster.UserOperationSponsored(
            address(usdc),
            sender,
            USER_OP_HASH,
            1_000_000,
            404,
            404,
            2_999_596
        );

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opSucceeded, context, 0.0004 ether, 1);
    }

    function test_pullsAdditionalUsdcOnShortfall() public {
        uint256 maxTokenCost = 1_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), 5_000_000);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"7788", maxTokenCost, 32);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        vm.expectEmit(true, true, true, true);
        emit TaikoUsdcPaymaster.UserOperationSponsored(
            address(usdc), sender, USER_OP_HASH, 1_000_000, 2_000_000, 2_000_000, 0
        );

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opSucceeded, context, 2 ether, 0);

        assertEq(usdc.balanceOf(address(paymaster)), 2_000_000);
    }

    function test_capsChargesAtPrefundOnOpReverted() public {
        uint256 maxTokenCost = 1_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), 5_000_000);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"8899", maxTokenCost, 33);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        vm.expectEmit(true, true, true, true);
        emit TaikoUsdcPaymaster.UserOperationSponsored(
            address(usdc), sender, USER_OP_HASH, 1_000_000, 2_000_000, 1_000_000, 0
        );

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opReverted, context, 2 ether, 0);

        assertEq(usdc.balanceOf(address(paymaster)), 1_000_000);
    }

    function test_skipsRefundOnPostOpReverted() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"9911", maxTokenCost, 34);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        vm.expectEmit(true, true, true, true);
        emit TaikoUsdcPaymaster.UserOperationSponsored(
            address(usdc), sender, USER_OP_HASH, 1_000_000, 400, 3_000_000, 0
        );

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.postOpReverted, context, 0.0004 ether, 0);

        assertEq(usdc.balanceOf(address(paymaster)), 3_000_000);
    }

    function test_rejectsValidateAndPostOpWhilePaused() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"aabb", maxTokenCost, 35);

        paymaster.setPaused(true);

        vm.expectRevert(TaikoUsdcPaymaster.PaymasterPaused.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        paymaster.setPaused(false);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        paymaster.setPaused(true);

        vm.expectRevert(TaikoUsdcPaymaster.PaymasterPaused.selector);
        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opSucceeded, context, 0.0004 ether, 0);
    }

    function test_enforcesGasBounds() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) =
            _buildUserOp(sender, hex"beef", maxTokenCost, 41, 300_000, 0, 0, _emptyPermit());

        vm.expectRevert(TaikoUsdcPaymaster.GasLimitTooHigh.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_rejectsMutatedGasFieldsAfterSigning() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"abcd", maxTokenCost, 42);
        userOp.accountGasLimits = _packAccountGasLimits(120_000, 150_000);

        vm.expectRevert(TaikoUsdcPaymaster.InvalidQuoteSignature.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_rejectsMutatedPaymasterGasFieldsAfterSigning() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"ef01", maxTokenCost, 43);

        bytes memory paymasterData = _slicePaymasterData(userOp.paymasterAndData);
        userOp.paymasterAndData = abi.encodePacked(
            address(paymaster),
            uint128(DEFAULT_PAYMASTER_VALIDATION_GAS + 1),
            DEFAULT_PAYMASTER_POSTOP_GAS,
            paymasterData
        );

        vm.expectRevert(TaikoUsdcPaymaster.InvalidQuoteSignature.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_rejectsQuoteWithTooHighOverhead() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOp(
            sender,
            hex"aa11",
            maxTokenCost,
            44,
            120_000,
            100_001,
            0,
            _emptyPermit()
        );

        vm.expectRevert(TaikoUsdcPaymaster.QuotePostOpOverheadTooHigh.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_rejectsQuoteWithTooHighSurcharge() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOp(
            sender,
            hex"bb22",
            maxTokenCost,
            45,
            120_000,
            0,
            1_001,
            _emptyPermit()
        );

        vm.expectRevert(TaikoUsdcPaymaster.InvalidBps.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_ownerEntryPointDepositAndStake() public {
        vm.deal(address(this), 1 ether);

        paymaster.deposit{value: 0.02 ether}();
        assertEq(entryPoint.deposits(address(paymaster)), 0.02 ether);

        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        paymaster.withdrawTo(payable(receiver), 0.005 ether);

        paymaster.withdrawTo(payable(receiver), 0.005 ether);
        assertEq(entryPoint.deposits(address(paymaster)), 0.015 ether);

        paymaster.addStake{value: 0.01 ether}(1);
        assertEq(entryPoint.stakes(address(paymaster)), 0.01 ether);

        paymaster.withdrawStake(payable(receiver));
        assertEq(entryPoint.stakes(address(paymaster)), 0);
    }

    function test_ownerControlsAndLimitsValidation() public {
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        paymaster.transferOwnership(other);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        paymaster.transferOwnership(address(0));

        paymaster.transferOwnership(other);
        assertEq(paymaster.owner(), other);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        paymaster.setPaused(true);

        vm.prank(other);
        paymaster.setPaused(true);
        assertTrue(paymaster.paused());

        vm.prank(other);
        paymaster.setPaused(false);
        assertFalse(paymaster.paused());

        vm.prank(other);
        vm.expectRevert(TaikoUsdcPaymaster.InvalidLimits.selector);
        paymaster.setLimits(0, 0, 1, 1, 0);

        vm.prank(other);
        vm.expectRevert(TaikoUsdcPaymaster.InvalidLimits.selector);
        paymaster.setLimits(200_000, 1_000_001, 1, 1, 0);

        vm.prank(other);
        vm.expectRevert(TaikoUsdcPaymaster.InvalidLimits.selector);
        paymaster.setLimits(200_000, 0, 1, 0, 0);

        vm.prank(other);
        vm.expectRevert(TaikoUsdcPaymaster.InvalidLimits.selector);
        paymaster.setLimits(200_000, 50_000, 1 ether, 300, 10_001);

        vm.prank(other);
        paymaster.setLimits(250_000, 50_000, 1 ether, 300, 750);
        assertEq(paymaster.maxVerificationGasLimit(), 250_000);
        assertEq(paymaster.maxPostOpOverheadGas(), 50_000);
        assertEq(paymaster.maxNativeCostWei(), 1 ether);
        assertEq(paymaster.maxQuoteTtlSeconds(), 300);
        assertEq(paymaster.maxSurchargeBps(), 750);

        usdc.mint(address(paymaster), 50_000);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        paymaster.withdrawToken(address(usdc), receiver, 1);

        uint256 receiverBefore = usdc.balanceOf(receiver);
        vm.prank(other);
        paymaster.withdrawToken(address(usdc), receiver, 50_000);
        assertEq(usdc.balanceOf(receiver), receiverBefore + 50_000);
    }

    function test_preventsWithdrawOfLockedPrefund() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"ff66", maxTokenCost, 90);

        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        assertEq(paymaster.lockedUsdcPrefund(), maxTokenCost);

        vm.expectRevert(TaikoUsdcPaymaster.InsufficientUnlockedBalance.selector);
        paymaster.withdrawToken(address(usdc), receiver, maxTokenCost);

        usdc.mint(address(paymaster), 500_000);

        paymaster.withdrawToken(address(usdc), receiver, 500_000);
        assertEq(usdc.balanceOf(receiver), 500_000);
    }

    function test_unlocksPrefundAfterPostOp() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"1177", maxTokenCost, 91);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        assertEq(paymaster.lockedUsdcPrefund(), maxTokenCost);

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opSucceeded, context, 0.0004 ether, 0);

        assertEq(paymaster.lockedUsdcPrefund(), 0);
    }
}
