// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEntryPoint, IPaymaster, UserOperation} from "./interfaces/AccountAbstraction.sol";

interface IERC20 {
    function allowance(address owner, address spender) external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

interface IUsdcPriceOracle {
    function quoteUsdcForWei(uint256 weiAmount) external view returns (uint256 usdcAmount);

    function usdcPerEth() external view returns (uint256 microsPerEth);
}

contract TaikoUsdcPaymaster is IPaymaster {
    struct QuoteData {
        address sender;
        address token;
        address entryPoint;
        uint256 chainId;
        uint256 maxTokenCost;
        uint48 validAfter;
        uint48 validUntil;
        uint256 nonce;
        bytes32 callDataHash;
    }

    struct PermitData {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct PaymasterContext {
        address sender;
        bytes32 userOpHash;
        bytes32 quoteHash;
        uint256 prefund;
    }

    uint256 private constant _MAX_BPS = 10_000;
    uint256 private constant _MAX_POST_OP_OVERHEAD_GAS = 1_000_000;
    uint256 private constant _SIG_VALIDATION_FAILED = 1;
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _QUOTE_TYPEHASH =
        keccak256(
            "QuoteData(address sender,address token,address entryPoint,uint256 chainId,uint256 maxTokenCost,uint48 validAfter,uint48 validUntil,uint256 nonce,bytes32 callDataHash)"
        );
    bytes32 private constant _NAME_HASH = keccak256("TaikoUsdcPaymaster");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    uint256 private constant _SECP256K1N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    error NotOwner();
    error NotEntryPoint();
    error PaymasterPaused();
    error InvalidPaymasterData();
    error InvalidQuoteSender();
    error InvalidQuoteToken();
    error InvalidQuoteEntryPoint();
    error InvalidQuoteChain();
    error InvalidQuoteCallData();
    error QuoteExpired();
    error QuoteTtlTooLong();
    error QuoteAlreadyUsed();
    error InvalidQuoteSignature();
    error GasLimitTooHigh();
    error MaxCostExceeded();
    error InsufficientAllowance();
    error InsufficientBalance();
    error InvalidAddress();
    error InvalidBps();
    error InvalidLimits();
    error TokenTransferFailed();
    error ReentrancyGuard();

    event UserOperationSponsored(
        address indexed token,
        address indexed sender,
        bytes32 indexed userOpHash,
        uint256 nativeTokenPriceMicros,
        uint256 actualTokenNeeded,
        uint256 feeTokenAmount,
        uint256 refundAmount
    );

    event QuoteSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event OracleUpdated(address indexed previousOracle, address indexed newOracle);
    event SurchargeBpsUpdated(uint256 previousBps, uint256 newBps);
    event LimitsUpdated(
        uint256 maxVerificationGasLimit,
        uint256 maxPostOpOverheadGas,
        uint256 maxNativeCostWei,
        uint256 maxQuoteTtlSeconds
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PausedSet(bool paused);

    IEntryPoint public immutable entryPoint;
    IERC20 public immutable usdc;

    address public owner;
    address public quoteSigner;
    IUsdcPriceOracle public priceOracle;

    uint256 public surchargeBps;
    uint256 public maxVerificationGasLimit;
    uint256 public postOpOverheadGas;
    uint256 public maxNativeCostWei;
    uint256 public maxQuoteTtlSeconds;
    bool public paused;

    mapping(bytes32 => bool) public usedQuoteHashes;

    uint256 private _reentrancyStatus;

    constructor(
        address owner_,
        address entryPoint_,
        address usdc_,
        address quoteSigner_,
        address priceOracle_,
        uint256 surchargeBps_,
        uint256 maxVerificationGasLimit_,
        uint256 postOpOverheadGas_,
        uint256 maxNativeCostWei_,
        uint256 maxQuoteTtlSeconds_
    ) {
        if (
            owner_ == address(0) ||
            entryPoint_ == address(0) ||
            usdc_ == address(0) ||
            quoteSigner_ == address(0) ||
            priceOracle_ == address(0)
        ) {
            revert InvalidAddress();
        }
        if (surchargeBps_ > _MAX_BPS) {
            revert InvalidBps();
        }
        _validateLimits(maxVerificationGasLimit_, postOpOverheadGas_, maxNativeCostWei_, maxQuoteTtlSeconds_);

        owner = owner_;
        entryPoint = IEntryPoint(entryPoint_);
        usdc = IERC20(usdc_);
        quoteSigner = quoteSigner_;
        priceOracle = IUsdcPriceOracle(priceOracle_);
        surchargeBps = surchargeBps_;
        maxVerificationGasLimit = maxVerificationGasLimit_;
        postOpOverheadGas = postOpOverheadGas_;
        maxNativeCostWei = maxNativeCostWei_;
        maxQuoteTtlSeconds = maxQuoteTtlSeconds_;
        _reentrancyStatus = _NOT_ENTERED;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert NotOwner();
        }
        _;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) {
            revert NotEntryPoint();
        }
        _;
    }

    modifier whenNotPaused() {
        if (paused) {
            revert PaymasterPaused();
        }
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyStatus == _ENTERED) {
            revert ReentrancyGuard();
        }
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    function validatePaymasterUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external override onlyEntryPoint whenNotPaused nonReentrant returns (bytes memory context, uint256 validationData) {
        if (userOp.verificationGasLimit > maxVerificationGasLimit) {
            revert GasLimitTooHigh();
        }
        if (maxCost > maxNativeCostWei) {
            revert MaxCostExceeded();
        }
        if (userOp.paymasterAndData.length <= 20) {
            revert InvalidPaymasterData();
        }

        bytes calldata paymasterData = userOp.paymasterAndData[20:];
        (QuoteData memory quote, bytes memory quoteSignature, PermitData memory permitData) =
            abi.decode(paymasterData, (QuoteData, bytes, PermitData));

        _validateQuote(userOp, quote);

        bytes32 signedQuoteHash = _hashTypedDataV4(_hashQuote(quote));

        if (usedQuoteHashes[signedQuoteHash]) {
            revert QuoteAlreadyUsed();
        }

        if (_recoverSigner(signedQuoteHash, quoteSignature) != quoteSigner) {
            revert InvalidQuoteSignature();
        }

        uint256 requiredPrefund = _applySurcharge(priceOracle.quoteUsdcForWei(maxCost));
        if (requiredPrefund > quote.maxTokenCost) {
            revert MaxCostExceeded();
        }

        if (usdc.allowance(userOp.sender, address(this)) < quote.maxTokenCost) {
            if (permitData.value > 0) {
                try IERC20Permit(address(usdc)).permit(
                    userOp.sender,
                    address(this),
                    permitData.value,
                    permitData.deadline,
                    permitData.v,
                    permitData.r,
                    permitData.s
                ) {} catch {}
            }

            if (usdc.allowance(userOp.sender, address(this)) < quote.maxTokenCost) {
                revert InsufficientAllowance();
            }
        }

        if (usdc.balanceOf(userOp.sender) < quote.maxTokenCost) {
            revert InsufficientBalance();
        }

        usedQuoteHashes[signedQuoteHash] = true;

        _safeTransferFrom(address(usdc), userOp.sender, address(this), quote.maxTokenCost);

        context = abi.encode(
            PaymasterContext({sender: userOp.sender, userOpHash: userOpHash, quoteHash: signedQuoteHash, prefund: quote.maxTokenCost})
        );
        validationData = _packValidationData(false, quote.validUntil, quote.validAfter);
    }

    function postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) external override onlyEntryPoint whenNotPaused nonReentrant {
        PaymasterContext memory paymasterContext = abi.decode(context, (PaymasterContext));

        uint256 nativeCostWithOverhead = actualGasCost + (actualUserOpFeePerGas * postOpOverheadGas);
        uint256 actualTokenNeeded = _applySurcharge(priceOracle.quoteUsdcForWei(nativeCostWithOverhead));

        uint256 feeTokenAmount = paymasterContext.prefund;
        uint256 refundAmount;

        if (mode != PostOpMode.postOpReverted) {
            if (actualTokenNeeded < paymasterContext.prefund) {
                refundAmount = paymasterContext.prefund - actualTokenNeeded;
                feeTokenAmount = actualTokenNeeded;
                if (refundAmount > 0) {
                    _safeTransfer(address(usdc), paymasterContext.sender, refundAmount);
                }
            } else if (actualTokenNeeded > paymasterContext.prefund && mode == PostOpMode.opSucceeded) {
                uint256 shortfall = actualTokenNeeded - paymasterContext.prefund;
                uint256 additionalPulled = _tryPullAdditionalCharge(paymasterContext.sender, shortfall);
                feeTokenAmount = paymasterContext.prefund + additionalPulled;
            }
        }

        emit UserOperationSponsored(
            address(usdc),
            paymasterContext.sender,
            paymasterContext.userOpHash,
            priceOracle.usdcPerEth(),
            actualTokenNeeded,
            feeTokenAmount,
            refundAmount
        );
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) {
            revert InvalidAddress();
        }

        address previous = owner;
        owner = newOwner;

        emit OwnershipTransferred(previous, newOwner);
    }

    function setQuoteSigner(address signer) external onlyOwner {
        if (signer == address(0)) {
            revert InvalidAddress();
        }

        address previous = quoteSigner;
        quoteSigner = signer;

        emit QuoteSignerUpdated(previous, signer);
    }

    function setPriceOracle(address oracle) external onlyOwner {
        if (oracle == address(0)) {
            revert InvalidAddress();
        }

        address previous = address(priceOracle);
        priceOracle = IUsdcPriceOracle(oracle);

        emit OracleUpdated(previous, oracle);
    }

    function setSurchargeBps(uint256 newSurchargeBps) external onlyOwner {
        if (newSurchargeBps > _MAX_BPS) {
            revert InvalidBps();
        }

        uint256 previous = surchargeBps;
        surchargeBps = newSurchargeBps;

        emit SurchargeBpsUpdated(previous, newSurchargeBps);
    }

    function setLimits(
        uint256 maxVerificationGasLimit_,
        uint256 postOpOverheadGas_,
        uint256 maxNativeCostWei_,
        uint256 maxQuoteTtlSeconds_
    ) external onlyOwner {
        _validateLimits(maxVerificationGasLimit_, postOpOverheadGas_, maxNativeCostWei_, maxQuoteTtlSeconds_);

        maxVerificationGasLimit = maxVerificationGasLimit_;
        postOpOverheadGas = postOpOverheadGas_;
        maxNativeCostWei = maxNativeCostWei_;
        maxQuoteTtlSeconds = maxQuoteTtlSeconds_;

        emit LimitsUpdated(maxVerificationGasLimit_, postOpOverheadGas_, maxNativeCostWei_, maxQuoteTtlSeconds_);
    }

    function depositToEntryPoint() external payable onlyOwner {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    function withdrawFromEntryPoint(address payable to, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(to, amount);
    }

    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        entryPoint.addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        entryPoint.unlockStake();
    }

    function withdrawStake(address payable to) external onlyOwner {
        entryPoint.withdrawStake(to);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        _safeTransfer(token, to, amount);
    }

    function quoteHash(QuoteData calldata quote) external view returns (bytes32) {
        return _hashTypedDataV4(_hashQuote(quote));
    }

    function _validateQuote(UserOperation calldata userOp, QuoteData memory quote) private view {
        if (quote.sender != userOp.sender) {
            revert InvalidQuoteSender();
        }
        if (quote.token != address(usdc)) {
            revert InvalidQuoteToken();
        }
        if (quote.entryPoint != address(entryPoint)) {
            revert InvalidQuoteEntryPoint();
        }
        if (quote.chainId != block.chainid) {
            revert InvalidQuoteChain();
        }
        if (quote.callDataHash != keccak256(userOp.callData)) {
            revert InvalidQuoteCallData();
        }
        if (quote.validAfter > block.timestamp || quote.validUntil < block.timestamp || quote.validUntil < quote.validAfter) {
            revert QuoteExpired();
        }
        if (quote.validUntil > block.timestamp + maxQuoteTtlSeconds) {
            revert QuoteTtlTooLong();
        }
    }

    function _hashQuote(QuoteData memory quote) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                _QUOTE_TYPEHASH,
                quote.sender,
                quote.token,
                quote.entryPoint,
                quote.chainId,
                quote.maxTokenCost,
                quote.validAfter,
                quote.validUntil,
                quote.nonce,
                quote.callDataHash
            )
        );
    }

    function _hashTypedDataV4(bytes32 structHash) private view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(_EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this))
        );

        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _recoverSigner(bytes32 digest, bytes memory signature) private pure returns (address recoveredSigner) {
        if (signature.length != 65) {
            revert InvalidQuoteSignature();
        }

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }

        if (uint256(s) > _SECP256K1N_HALF) {
            revert InvalidQuoteSignature();
        }

        if (v < 27) {
            v += 27;
        }

        if (v != 27 && v != 28) {
            revert InvalidQuoteSignature();
        }

        recoveredSigner = ecrecover(digest, v, r, s);

        if (recoveredSigner == address(0)) {
            revert InvalidQuoteSignature();
        }
    }

    function _applySurcharge(uint256 amount) private view returns (uint256) {
        if (amount == 0) {
            return 0;
        }

        return ((amount * (_MAX_BPS + surchargeBps)) + (_MAX_BPS - 1)) / _MAX_BPS;
    }

    function _packValidationData(bool sigFailed, uint48 validUntil, uint48 validAfter) private pure returns (uint256) {
        return (sigFailed ? _SIG_VALIDATION_FAILED : 0) | (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }

    function _validateLimits(
        uint256 maxVerificationGasLimit_,
        uint256 postOpOverheadGas_,
        uint256 maxNativeCostWei_,
        uint256 maxQuoteTtlSeconds_
    ) private pure {
        if (
            maxVerificationGasLimit_ == 0 ||
            postOpOverheadGas_ > _MAX_POST_OP_OVERHEAD_GAS ||
            maxNativeCostWei_ == 0 ||
            maxQuoteTtlSeconds_ == 0
        ) {
            revert InvalidLimits();
        }
    }

    function _tryPullAdditionalCharge(address from, uint256 requestedAmount) private returns (uint256 pulledAmount) {
        uint256 allowance = usdc.allowance(from, address(this));
        uint256 balance = usdc.balanceOf(from);

        pulledAmount = requestedAmount;

        if (pulledAmount > allowance) {
            pulledAmount = allowance;
        }
        if (pulledAmount > balance) {
            pulledAmount = balance;
        }

        if (pulledAmount > 0) {
            _safeTransferFrom(address(usdc), from, address(this), pulledAmount);
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert TokenTransferFailed();
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert TokenTransferFailed();
        }
    }
}
