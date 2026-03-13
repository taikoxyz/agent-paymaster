// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {IPaymaster} from "account-abstraction/contracts/interfaces/IPaymaster.sol";
import {PackedUserOperation} from "account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TaikoUsdcPaymaster} from "../src/TaikoUsdcPaymaster.sol";
import {MockEntryPoint} from "./mocks/MockEntryPoint.sol";
import {MockERC1271Wallet} from "./mocks/MockERC1271Wallet.sol";
import {MockERC20Permit} from "./mocks/MockERC20Permit.sol";

contract TaikoUsdcPaymasterTest is Test {
    MockEntryPoint internal entryPoint;
    MockERC20Permit internal usdc;
    TaikoUsdcPaymaster internal paymaster;

    address internal owner;
    uint256 internal senderKey;
    uint256 internal quoteSignerKey;
    uint256 internal contractWalletSignerKey;
    address internal quoteSigner;
    address internal sender;
    address internal receiver;
    address internal other;

    bytes32 internal constant USER_OP_HASH = keccak256("user-operation-hash");

    uint256 internal constant DEFAULT_CALL_GAS_LIMIT = 120_000;
    uint256 internal constant DEFAULT_PRE_VERIFICATION_GAS = 30_000;
    uint256 internal constant DEFAULT_MAX_FEE_PER_GAS = 1_000_000_000;
    uint256 internal constant DEFAULT_MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000;
    uint128 internal constant DEFAULT_PAYMASTER_VALIDATION_GAS = 100_000;
    uint128 internal constant DEFAULT_PAYMASTER_POSTOP_GAS = 100_000;

    struct QuoteData {
        address token;
        uint256 exchangeRate;
        uint256 maxTokenCost;
        uint48 validAfter;
        uint48 validUntil;
        uint32 postOpOverheadGas;
        uint16 surchargeBps;
    }

    struct PermitData {
        uint256 value;
        uint256 deadline;
        bytes signature;
    }

    function setUp() public {
        owner = address(this);
        senderKey = 0xB0B;
        quoteSignerKey = 0xA11CE;
        contractWalletSignerKey = 0xC0FFEE;
        sender = vm.addr(senderKey);
        quoteSigner = vm.addr(quoteSignerKey);
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
        return PermitData({value: 0, deadline: 0, signature: ""});
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
            postOpOverheadGas: quote.postOpOverheadGas,
            surchargeBps: quote.surchargeBps
        });
    }

    function _signDigest(uint256 signerKey_, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey_, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signQuote(PackedUserOperation memory userOp, QuoteData memory quote) internal view returns (bytes memory) {
        bytes32 digest = paymaster.quoteHash(userOp, _toContractQuote(quote));
        return _signDigest(quoteSignerKey, digest);
    }

    function _signPermit(address owner_, uint256 ownerKey_, uint256 value, uint256 deadline)
        internal
        view
        returns (PermitData memory)
    {
        bytes32 digest = usdc.permitDigest(owner_, address(paymaster), value, usdc.nonces(owner_), deadline);
        return PermitData({value: value, deadline: deadline, signature: _signDigest(ownerKey_, digest)});
    }

    function _buildUserOp(
        address sender_,
        bytes memory callData_,
        uint256 maxTokenCost_,
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

    function _buildUserOpSimple(address sender_, bytes memory callData_, uint256 maxTokenCost_)
        internal
        view
        returns (PackedUserOperation memory, QuoteData memory)
    {
        return _buildUserOp(sender_, callData_, maxTokenCost_, 120_000, 0, 0, _emptyPermit());
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

    function test_locksPrefundOnValidate() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"123456", maxTokenCost);

        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        assertEq(usdc.balanceOf(address(paymaster)), maxTokenCost);
        assertEq(paymaster.lockedUsdcPrefund(), maxTokenCost);
    }

    function test_usesBytesPermitWhenAllowanceMissing() public {
        uint256 maxTokenCost = 2_500_000;
        uint256 deadline = block.timestamp + 300;
        PermitData memory permit = _signPermit(sender, senderKey, maxTokenCost, deadline);

        (PackedUserOperation memory userOp,) =
            _buildUserOp(sender, hex"55aa", maxTokenCost, 120_000, 0, 0, permit);

        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        assertEq(usdc.balanceOf(address(paymaster)), maxTokenCost);
        assertEq(usdc.nonces(sender), 1);
    }

    function test_fallsBackToAllowanceWhenPermitFails() public {
        uint256 maxTokenCost = 2_500_000;
        uint256 expiredDeadline = block.timestamp - 1;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        PermitData memory permit = _signPermit(sender, senderKey, maxTokenCost, expiredDeadline);
        (PackedUserOperation memory userOp,) =
            _buildUserOp(sender, hex"90ab", maxTokenCost, 120_000, 0, 0, permit);

        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        assertEq(usdc.balanceOf(address(paymaster)), maxTokenCost);
        assertEq(usdc.nonces(sender), 0);
    }

    function test_rejectsWhenPermitAndAllowanceMissing() public {
        uint256 maxTokenCost = 2_500_000;

        (PackedUserOperation memory userOp,) =
            _buildUserOp(sender, hex"90ab", maxTokenCost, 120_000, 0, 0, _emptyPermit());

        vm.expectRevert(TaikoUsdcPaymaster.InsufficientAllowance.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_refundsExcessUsdcInPostOp() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"6677", maxTokenCost);

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

        (PackedUserOperation memory userOp,) =
            _buildUserOp(sender, hex"cc33", maxTokenCost, 120_000, 50_000, 100, _emptyPermit());

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        vm.expectEmit(true, true, true, true);
        emit TaikoUsdcPaymaster.UserOperationSponsored(
            address(usdc), sender, USER_OP_HASH, 1_000_000, 404, 404, 2_999_596
        );

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opSucceeded, context, 0.0004 ether, 1);
    }

    function test_pullsAdditionalUsdcOnShortfall() public {
        uint256 maxTokenCost = 1_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), 5_000_000);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"7788", maxTokenCost);

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

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"8899", maxTokenCost);

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

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"9911", maxTokenCost);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        vm.expectEmit(true, true, true, true);
        emit TaikoUsdcPaymaster.UserOperationSponsored(
            address(usdc), sender, USER_OP_HASH, 1_000_000, 400, 3_000_000, 0
        );

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.postOpReverted, context, 0.0004 ether, 0);

        assertEq(usdc.balanceOf(address(paymaster)), 3_000_000);
    }

    function test_rejectsValidateWhenQuoteSignerDisabled() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"aabb", maxTokenCost);

        paymaster.setQuoteSigner(address(0));

        vm.expectRevert(TaikoUsdcPaymaster.QuoteSignerDisabled.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_enforcesGasBounds() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) =
            _buildUserOp(sender, hex"beef", maxTokenCost, 300_000, 0, 0, _emptyPermit());

        vm.expectRevert(TaikoUsdcPaymaster.GasLimitTooHigh.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_rejectsMutatedGasFieldsAfterSigning() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"abcd", maxTokenCost);
        userOp.accountGasLimits = _packAccountGasLimits(120_000, 150_000);

        vm.expectRevert(TaikoUsdcPaymaster.InvalidQuoteSignature.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_rejectsMutatedPaymasterGasFieldsAfterSigning() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"ef01", maxTokenCost);

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

        (PackedUserOperation memory userOp,) =
            _buildUserOp(sender, hex"aa11", maxTokenCost, 120_000, 100_001, 0, _emptyPermit());

        vm.expectRevert(TaikoUsdcPaymaster.QuotePostOpOverheadTooHigh.selector);
        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);
    }

    function test_rejectsQuoteWithTooHighSurcharge() public {
        uint256 maxTokenCost = 3_000_000;

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) =
            _buildUserOp(sender, hex"bb22", maxTokenCost, 120_000, 0, 1_001, _emptyPermit());

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
        paymaster.setQuoteSigner(address(0));

        vm.prank(other);
        paymaster.setQuoteSigner(address(0));
        assertEq(paymaster.quoteSigner(), address(0));

        vm.prank(other);
        paymaster.setQuoteSigner(quoteSigner);
        assertEq(paymaster.quoteSigner(), quoteSigner);

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

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"ff66", maxTokenCost);

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

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"1177", maxTokenCost);

        (bytes memory context,) =
            entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        assertEq(paymaster.lockedUsdcPrefund(), maxTokenCost);

        entryPoint.callPostOp(paymaster, IPaymaster.PostOpMode.opSucceeded, context, 0.0004 ether, 0);

        assertEq(paymaster.lockedUsdcPrefund(), 0);
    }

    function test_acceptsContractQuoteSigner() public {
        uint256 maxTokenCost = 3_000_000;
        MockERC1271Wallet quoteSignerWallet = new MockERC1271Wallet(quoteSigner);

        paymaster.setQuoteSigner(address(quoteSignerWallet));

        vm.prank(sender);
        usdc.approve(address(paymaster), maxTokenCost);

        (PackedUserOperation memory userOp,) = _buildUserOpSimple(sender, hex"4455", maxTokenCost);

        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        assertEq(usdc.balanceOf(address(paymaster)), maxTokenCost);
    }

    function test_usesPermitForContractWalletSender() public {
        uint256 maxTokenCost = 2_500_000;
        uint256 deadline = block.timestamp + 300;
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(contractWalletSignerKey));

        usdc.mint(address(wallet), maxTokenCost);

        PermitData memory permit = _signPermit(address(wallet), contractWalletSignerKey, maxTokenCost, deadline);
        (PackedUserOperation memory userOp,) =
            _buildUserOp(address(wallet), hex"667788", maxTokenCost, 120_000, 0, 0, permit);

        entryPoint.callValidatePaymaster(paymaster, userOp, USER_OP_HASH, 0.001 ether);

        assertEq(usdc.balanceOf(address(paymaster)), maxTokenCost);
        assertEq(usdc.nonces(address(wallet)), 1);
    }
}
