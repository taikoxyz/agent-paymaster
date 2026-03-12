// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BasePaymaster} from "account-abstraction/contracts/core/BasePaymaster.sol";
import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {UserOperationLib} from "account-abstraction/contracts/core/UserOperationLib.sol";
import {_packValidationData} from "account-abstraction/contracts/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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

/// @custom:security-contact security@agent-paymaster.dev
contract TaikoUsdcPaymaster is BasePaymaster, EIP712, ReentrancyGuard {
    using UserOperationLib for PackedUserOperation;

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

    struct PaymasterContext {
        address sender;
        bytes32 userOpHash;
        uint256 prefund;
        uint256 exchangeRate;
        uint256 postOpOverheadGas;
        uint256 surchargeBps;
    }

    uint256 private constant _MAX_BPS = 10_000;
    uint256 private constant _MAX_POST_OP_OVERHEAD_GAS = 1_000_000;

    bytes32 private constant _SPONSORED_USER_OPERATION_TYPEHASH =
        keccak256(
            "SponsoredUserOperation(address sender,uint256 nonce,bytes32 initCodeHash,bytes32 callDataHash,bytes32 accountGasLimits,bytes32 paymasterGasLimits,uint256 preVerificationGas,bytes32 gasFees,address token,uint256 exchangeRate,uint256 maxTokenCost,uint48 validAfter,uint48 validUntil,uint256 quoteNonce,uint32 postOpOverheadGas,uint16 surchargeBps,uint256 chainId,address paymaster)"
        );

    IERC20 public immutable usdc;

    address public quoteSigner;
    uint256 public maxVerificationGasLimit;
    uint256 public maxPostOpOverheadGas;
    uint256 public maxNativeCostWei;
    uint256 public maxQuoteTtlSeconds;
    uint256 public maxSurchargeBps;
    bool public paused;

    mapping(bytes32 quoteHash => bool used) public usedQuoteHashes;

    uint256 public lockedUsdcPrefund;

    event UserOperationSponsored(
        address indexed token,
        address indexed sender,
        bytes32 indexed userOpHash,
        uint256 exchangeRateMicrosPerEth,
        uint256 actualTokenNeeded,
        uint256 feeTokenAmount,
        uint256 refundAmount
    );

    event QuoteSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event LimitsUpdated(
        uint256 maxVerificationGasLimit,
        uint256 maxPostOpOverheadGas,
        uint256 maxNativeCostWei,
        uint256 maxQuoteTtlSeconds,
        uint256 maxSurchargeBps
    );
    event PausedSet(bool paused);

    error PaymasterPaused();
    error InvalidPaymasterData();
    error InvalidQuoteToken();
    error InvalidQuoteExchangeRate();
    error InvalidQuoteMaxTokenCost();
    error QuoteExpired();
    error QuoteTtlTooLong();
    error QuoteAlreadyUsed();
    error InvalidQuoteSignature();
    error QuotePostOpOverheadTooHigh();
    error GasLimitTooHigh();
    error MaxCostExceeded();
    error InsufficientAllowance();
    error InsufficientBalance();
    error InvalidAddress();
    error InvalidBps();
    error InvalidLimits();
    error TokenTransferFailed();
    error InsufficientUnlockedBalance();

    modifier whenNotPaused() {
        if (paused) {
            revert PaymasterPaused();
        }
        _;
    }

    constructor(
        IEntryPoint _entryPoint,
        address _usdc,
        address _quoteSigner,
        uint256 _maxVerificationGasLimit,
        uint256 _maxPostOpOverheadGas,
        uint256 _maxNativeCostWei,
        uint256 _maxQuoteTtlSeconds,
        uint256 _maxSurchargeBps
    ) BasePaymaster(_entryPoint) EIP712("TaikoUsdcPaymaster", "2") {
        if (_usdc == address(0) || _quoteSigner == address(0)) {
            revert InvalidAddress();
        }

        _validateLimits(
            _maxVerificationGasLimit,
            _maxPostOpOverheadGas,
            _maxNativeCostWei,
            _maxQuoteTtlSeconds,
            _maxSurchargeBps
        );

        usdc = IERC20(_usdc);
        quoteSigner = _quoteSigner;
        maxVerificationGasLimit = _maxVerificationGasLimit;
        maxPostOpOverheadGas = _maxPostOpOverheadGas;
        maxNativeCostWei = _maxNativeCostWei;
        maxQuoteTtlSeconds = _maxQuoteTtlSeconds;
        maxSurchargeBps = _maxSurchargeBps;
    }

    /// @notice Updates the quote signer used for EIP-712 sponsorship approvals.
    /// @param _signer The new signer address.
    function setQuoteSigner(address _signer) external onlyOwner {
        if (_signer == address(0)) {
            revert InvalidAddress();
        }

        address previous = quoteSigner;
        quoteSigner = _signer;

        emit QuoteSignerUpdated(previous, _signer);
    }

    /// @notice Pauses or unpauses sponsorship validation and settlement.
    /// @param _paused The new pause state.
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    /// @notice Updates protocol guardrails for quote acceptance and settlement.
    /// @param _maxVerificationGasLimit The maximum verification gas limit allowed on user operations.
    /// @param _maxPostOpOverheadGas The maximum quoted postOp overhead gas allowed in signed quotes.
    /// @param _maxNativeCostWei The maximum native prefund accepted from EntryPoint validation.
    /// @param _maxQuoteTtlSeconds The maximum quote validity window.
    /// @param _maxSurchargeBps The maximum surcharge permitted in signed quotes.
    function setLimits(
        uint256 _maxVerificationGasLimit,
        uint256 _maxPostOpOverheadGas,
        uint256 _maxNativeCostWei,
        uint256 _maxQuoteTtlSeconds,
        uint256 _maxSurchargeBps
    ) external onlyOwner {
        _validateLimits(
            _maxVerificationGasLimit,
            _maxPostOpOverheadGas,
            _maxNativeCostWei,
            _maxQuoteTtlSeconds,
            _maxSurchargeBps
        );

        maxVerificationGasLimit = _maxVerificationGasLimit;
        maxPostOpOverheadGas = _maxPostOpOverheadGas;
        maxNativeCostWei = _maxNativeCostWei;
        maxQuoteTtlSeconds = _maxQuoteTtlSeconds;
        maxSurchargeBps = _maxSurchargeBps;

        emit LimitsUpdated(
            _maxVerificationGasLimit,
            _maxPostOpOverheadGas,
            _maxNativeCostWei,
            _maxQuoteTtlSeconds,
            _maxSurchargeBps
        );
    }

    /// @notice Withdraws unlocked ERC-20 balances held by the paymaster.
    /// @param _token The ERC-20 token to withdraw.
    /// @param _to The recipient of the withdrawn tokens.
    /// @param _amount The amount to withdraw.
    function withdrawToken(address _token, address _to, uint256 _amount) external onlyOwner {
        if (_token == address(usdc)) {
            uint256 available = usdc.balanceOf(address(this)) - lockedUsdcPrefund;
            if (_amount > available) {
                revert InsufficientUnlockedBalance();
            }
        }

        _safeTransfer(_token, _to, _amount);
    }

    /// @notice Returns the EIP-712 digest of a quoted sponsorship for a given packed user operation.
    /// @param _userOp The packed user operation as seen by EntryPoint validation.
    /// @param _quote The quote payload carried in paymasterData.
    function quoteHash(
        PackedUserOperation calldata _userOp,
        QuoteData calldata _quote
    ) external view returns (bytes32) {
        return _hashTypedDataV4(_hashSponsoredUserOperation(_userOp, _quote));
    }

    function _validatePaymasterUserOp(
        PackedUserOperation calldata _userOp,
        bytes32 _userOpHash,
        uint256 _maxCost
    ) internal override whenNotPaused nonReentrant returns (bytes memory context, uint256 validationData) {
        if (_userOp.unpackVerificationGasLimit() > maxVerificationGasLimit) {
            revert GasLimitTooHigh();
        }

        if (_maxCost > maxNativeCostWei) {
            revert MaxCostExceeded();
        }

        if (_userOp.paymasterAndData.length <= PAYMASTER_DATA_OFFSET) {
            revert InvalidPaymasterData();
        }

        bytes calldata paymasterData = _userOp.paymasterAndData[PAYMASTER_DATA_OFFSET:];
        (QuoteData memory quote, bytes memory quoteSignature, PermitData memory permitData) =
            abi.decode(paymasterData, (QuoteData, bytes, PermitData));

        _validateQuote(quote);

        bytes32 signedQuoteHash = _hashTypedDataV4(_hashSponsoredUserOperation(_userOp, quote));
        if (usedQuoteHashes[signedQuoteHash]) {
            revert QuoteAlreadyUsed();
        }

        (address recovered, ECDSA.RecoverError recoverError,) = ECDSA.tryRecover(
            signedQuoteHash,
            quoteSignature
        );
        if (recoverError != ECDSA.RecoverError.NoError || recovered != quoteSigner) {
            revert InvalidQuoteSignature();
        }

        uint256 requiredPrefund = _applySurcharge((_maxCost * quote.exchangeRate) / 1e18, quote.surchargeBps);
        if (requiredPrefund > quote.maxTokenCost) {
            revert MaxCostExceeded();
        }

        if (usdc.allowance(_userOp.sender, address(this)) < quote.maxTokenCost) {
            if (permitData.value > 0) {
                try IERC20Permit(address(usdc)).permit(
                    _userOp.sender,
                    address(this),
                    permitData.value,
                    permitData.deadline,
                    permitData.v,
                    permitData.r,
                    permitData.s
                ) {} catch {}
            }

            if (usdc.allowance(_userOp.sender, address(this)) < quote.maxTokenCost) {
                revert InsufficientAllowance();
            }
        }

        if (usdc.balanceOf(_userOp.sender) < quote.maxTokenCost) {
            revert InsufficientBalance();
        }

        usedQuoteHashes[signedQuoteHash] = true;
        _safeTransferFrom(address(usdc), _userOp.sender, address(this), quote.maxTokenCost);
        lockedUsdcPrefund += quote.maxTokenCost;

        context = abi.encode(
            PaymasterContext({
                sender: _userOp.sender,
                userOpHash: _userOpHash,
                prefund: quote.maxTokenCost,
                exchangeRate: quote.exchangeRate,
                postOpOverheadGas: quote.postOpOverheadGas,
                surchargeBps: quote.surchargeBps
            })
        );

        validationData = _packValidationData(false, quote.validUntil, quote.validAfter);
    }

    function _postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) internal override whenNotPaused nonReentrant {
        PaymasterContext memory ctx = abi.decode(context, (PaymasterContext));

        uint256 nativeCostWithOverhead = actualGasCost + (actualUserOpFeePerGas * ctx.postOpOverheadGas);
        uint256 actualTokenNeeded = _applySurcharge(
            (nativeCostWithOverhead * ctx.exchangeRate) / 1e18,
            ctx.surchargeBps
        );

        uint256 feeTokenAmount = ctx.prefund;
        uint256 refundAmount;

        if (mode == PostOpMode.opSucceeded) {
            if (actualTokenNeeded < ctx.prefund) {
                refundAmount = ctx.prefund - actualTokenNeeded;
                feeTokenAmount = actualTokenNeeded;
                if (refundAmount > 0) {
                    _safeTransfer(address(usdc), ctx.sender, refundAmount);
                }
            } else if (actualTokenNeeded > ctx.prefund) {
                uint256 shortfall = actualTokenNeeded - ctx.prefund;
                _safeTransferFrom(address(usdc), ctx.sender, address(this), shortfall);
                feeTokenAmount = ctx.prefund + shortfall;
            }
        } else if (mode == PostOpMode.opReverted) {
            if (actualTokenNeeded < ctx.prefund) {
                refundAmount = ctx.prefund - actualTokenNeeded;
                feeTokenAmount = actualTokenNeeded;
                if (refundAmount > 0) {
                    _safeTransfer(address(usdc), ctx.sender, refundAmount);
                }
            }
        }

        lockedUsdcPrefund -= ctx.prefund;

        emit UserOperationSponsored(
            address(usdc),
            ctx.sender,
            ctx.userOpHash,
            ctx.exchangeRate,
            actualTokenNeeded,
            feeTokenAmount,
            refundAmount
        );
    }

    function _validateQuote(QuoteData memory _quote) private view {
        if (_quote.token != address(usdc)) {
            revert InvalidQuoteToken();
        }

        if (_quote.exchangeRate == 0) {
            revert InvalidQuoteExchangeRate();
        }

        if (_quote.maxTokenCost == 0) {
            revert InvalidQuoteMaxTokenCost();
        }

        if (
            _quote.validAfter > block.timestamp ||
            _quote.validUntil < block.timestamp ||
            _quote.validUntil < _quote.validAfter
        ) {
            revert QuoteExpired();
        }

        if (_quote.validUntil > block.timestamp + maxQuoteTtlSeconds) {
            revert QuoteTtlTooLong();
        }

        if (_quote.postOpOverheadGas > maxPostOpOverheadGas) {
            revert QuotePostOpOverheadTooHigh();
        }

        if (_quote.surchargeBps > maxSurchargeBps) {
            revert InvalidBps();
        }
    }

    function _hashSponsoredUserOperation(
        PackedUserOperation calldata _userOp,
        QuoteData memory _quote
    ) private view returns (bytes32) {
        bytes32 paymasterGasLimits = bytes32(
            _userOp.paymasterAndData[PAYMASTER_VALIDATION_GAS_OFFSET:PAYMASTER_DATA_OFFSET]
        );

        return keccak256(
            abi.encode(
                _SPONSORED_USER_OPERATION_TYPEHASH,
                _userOp.sender,
                _userOp.nonce,
                keccak256(_userOp.initCode),
                keccak256(_userOp.callData),
                _userOp.accountGasLimits,
                paymasterGasLimits,
                _userOp.preVerificationGas,
                _userOp.gasFees,
                _quote.token,
                _quote.exchangeRate,
                _quote.maxTokenCost,
                _quote.validAfter,
                _quote.validUntil,
                _quote.quoteNonce,
                _quote.postOpOverheadGas,
                _quote.surchargeBps,
                block.chainid,
                address(this)
            )
        );
    }

    function _applySurcharge(uint256 _amount, uint256 _surchargeBps) private pure returns (uint256) {
        if (_amount == 0) {
            return 0;
        }

        return ((_amount * (_MAX_BPS + _surchargeBps)) + (_MAX_BPS - 1)) / _MAX_BPS;
    }

    function _validateLimits(
        uint256 _maxVerificationGasLimit,
        uint256 _maxPostOpOverheadGas,
        uint256 _maxNativeCostWei,
        uint256 _maxQuoteTtlSeconds,
        uint256 _maxSurchargeBps
    ) private pure {
        if (
            _maxVerificationGasLimit == 0 ||
            _maxPostOpOverheadGas > _MAX_POST_OP_OVERHEAD_GAS ||
            _maxNativeCostWei == 0 ||
            _maxQuoteTtlSeconds == 0 ||
            _maxSurchargeBps > _MAX_BPS
        ) {
            revert InvalidLimits();
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert TokenTransferFailed();
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert TokenTransferFailed();
        }
    }
}
