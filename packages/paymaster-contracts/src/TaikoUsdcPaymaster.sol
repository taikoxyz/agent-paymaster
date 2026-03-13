// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BasePaymaster} from "account-abstraction/contracts/core/BasePaymaster.sol";
import {UserOperationLib} from "account-abstraction/contracts/core/UserOperationLib.sol";
import {_packValidationData} from "account-abstraction/contracts/core/Helpers.sol";
import {IEntryPoint} from "account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IERC20PermitBytes {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        bytes calldata signature
    ) external;
}

/// @title Taiko USDC Paymaster
/// @author Agent Paymaster
/// @notice ERC-4337 paymaster that sponsors user operations in exchange for USDC.
/// @dev The paymaster accepts an off-chain signed quote, locks the quote's maximum USDC charge during validation,
/// and settles the final USDC charge in `postOp`. Quotes are signed as EIP-712 typed data and bind the full
/// user operation gas shape, the quote terms, the current chain, and this paymaster address.
/// @custom:security-contact security@agent-paymaster.dev
contract TaikoUsdcPaymaster is BasePaymaster, EIP712 {
    using SafeERC20 for IERC20;
    using UserOperationLib for PackedUserOperation;

    /// @notice Commercial terms signed by the quote signer for one user operation.
    /// @param token ERC-20 token accepted for gas settlement. Must equal `usdc`.
    /// @param exchangeRate Price of 1 ETH in micro-USDC, scaled by 1e18 wei per ETH.
    /// @param maxTokenCost Maximum USDC amount, in token base units, that may be locked during validation.
    /// @param validAfter Inclusive timestamp after which the quote may be used.
    /// @param validUntil Inclusive timestamp after which the quote expires.
    /// @param postOpOverheadGas Extra gas, in wei-denominated gas units, charged on top of `actualGasCost`.
    /// @param surchargeBps Fee surcharge expressed in basis points, applied to the native-cost conversion.
    struct QuoteData {
        address token;
        uint256 exchangeRate;
        uint256 maxTokenCost;
        uint48 validAfter;
        uint48 validUntil;
        uint32 postOpOverheadGas;
        uint16 surchargeBps;
    }

    /// @notice Optional token permit bundled into `paymasterData`.
    /// @dev This uses the bytes-signature permit shape supported by Taiko/Circle-style USDC implementations.
    /// The paymaster attempts the bytes-based permit first, then falls back to standard ERC-2612 `v,r,s`
    /// decoding when the signature is 65 bytes long.
    /// @param value Allowance amount to authorize for the paymaster.
    /// @param deadline Permit deadline timestamp.
    /// @param signature Permit signature bytes. Empty bytes means no permit was supplied.
    struct PermitData {
        uint256 value;
        uint256 deadline;
        bytes signature;
    }

    /// @dev Encoded during validation and consumed in `postOp`.
    /// @param sender Account whose USDC balance is charged.
    /// @param userOpHash User operation hash emitted in settlement events.
    /// @param prefund Locked USDC amount pulled during validation. This is the quoted `maxTokenCost`.
    /// @param exchangeRate Price of 1 ETH in micro-USDC.
    /// @param postOpOverheadGas Additional gas units included in settlement.
    /// @param surchargeBps Fee surcharge applied during settlement.
    struct PaymasterContext {
        address sender;
        bytes32 userOpHash;
        uint256 prefund;
        uint256 exchangeRate;
        uint256 postOpOverheadGas;
        uint256 surchargeBps;
    }

    uint256 private constant _BASIS_POINTS_SCALE = 10_000;
    uint256 private constant _WEI_PER_ETH = 1e18;
    uint256 private constant _MAX_POST_OP_OVERHEAD_GAS = 1_000_000;

    bytes32 private constant _SPONSORED_USER_OPERATION_TYPEHASH =
        keccak256(
            "SponsoredUserOperation(address sender,uint256 nonce,bytes32 initCodeHash,bytes32 callDataHash,bytes32 accountGasLimits,bytes32 paymasterGasLimits,uint256 preVerificationGas,bytes32 gasFees,address token,uint256 exchangeRate,uint256 maxTokenCost,uint48 validAfter,uint48 validUntil,uint32 postOpOverheadGas,uint16 surchargeBps,uint256 chainId,address paymaster)"
        );

    IERC20 public immutable usdc;

    /// @notice Address that signs quote approvals. Setting this to `address(0)` disables new sponsorships.
    address public quoteSigner;

    /// @notice Maximum verification gas limit accepted from user operations.
    uint256 public maxVerificationGasLimit;

    /// @notice Maximum signed `postOpOverheadGas` allowed in quotes.
    uint256 public maxPostOpOverheadGas;

    /// @notice Maximum native `maxCost` accepted from EntryPoint validation.
    uint256 public maxNativeCostWei;

    /// @notice Maximum lifetime, in seconds, for a signed quote.
    uint256 public maxQuoteTtlSeconds;

    /// @notice Maximum surcharge, in basis points, allowed in quotes.
    uint256 public maxSurchargeBps;

    /// @notice Total USDC currently locked to cover unsettled user operations.
    /// @dev This tracks the sum of quoted `maxTokenCost` values collected during validation and not yet released in `postOp`.
    uint256 public lockedUsdcPrefund;

    /// @notice Emitted when a user operation is settled in USDC.
    /// @param token Settlement token address.
    /// @param sender Account charged for gas.
    /// @param userOpHash User operation hash from EntryPoint validation.
    /// @param exchangeRateMicrosPerEth Signed quote exchange rate in micro-USDC per ETH.
    /// @param actualTokenNeeded Final USDC charge computed from actual gas usage.
    /// @param feeTokenAmount USDC retained by the paymaster after any refund.
    /// @param refundAmount USDC returned to the sender.
    event UserOperationSponsored(
        address indexed token,
        address indexed sender,
        bytes32 indexed userOpHash,
        uint256 exchangeRateMicrosPerEth,
        uint256 actualTokenNeeded,
        uint256 feeTokenAmount,
        uint256 refundAmount
    );

    /// @notice Emitted when the quote signer is updated.
    /// @param previousSigner Previous quote signer.
    /// @param newSigner New quote signer. `address(0)` disables sponsorships.
    event QuoteSignerUpdated(address indexed previousSigner, address indexed newSigner);

    /// @notice Emitted when quote guardrails are updated.
    /// @param maxVerificationGasLimit New verification gas ceiling.
    /// @param maxPostOpOverheadGas New `postOp` overhead gas ceiling.
    /// @param maxNativeCostWei New native max-cost ceiling.
    /// @param maxQuoteTtlSeconds New quote TTL ceiling.
    /// @param maxSurchargeBps New surcharge ceiling.
    event LimitsUpdated(
        uint256 maxVerificationGasLimit,
        uint256 maxPostOpOverheadGas,
        uint256 maxNativeCostWei,
        uint256 maxQuoteTtlSeconds,
        uint256 maxSurchargeBps
    );

    // ---------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------

    /// @notice Creates the paymaster.
    /// @param _entryPoint ERC-4337 EntryPoint used by this paymaster.
    /// @param _usdc USDC token used for settlement.
    /// @param _quoteSigner Initial signer for sponsorship quotes.
    /// @param _maxVerificationGasLimit Maximum verification gas limit accepted.
    /// @param _maxPostOpOverheadGas Maximum signed `postOpOverheadGas`.
    /// @param _maxNativeCostWei Maximum native `maxCost` accepted from EntryPoint.
    /// @param _maxQuoteTtlSeconds Maximum signed quote lifetime in seconds.
    /// @param _maxSurchargeBps Maximum signed surcharge in basis points.
    constructor(
        IEntryPoint _entryPoint,
        address _usdc,
        address _quoteSigner,
        uint256 _maxVerificationGasLimit,
        uint256 _maxPostOpOverheadGas,
        uint256 _maxNativeCostWei,
        uint256 _maxQuoteTtlSeconds,
        uint256 _maxSurchargeBps
    ) BasePaymaster(_entryPoint) EIP712("TaikoUsdcPaymaster", "3") {
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

    // ---------------------------------------------------------------
    // External Functions
    // ---------------------------------------------------------------

    /// @notice Updates the quote signer used for EIP-712 quote approvals.
    /// @dev Setting the signer to `address(0)` disables new sponsorships without pausing administrative recovery paths.
    /// @param _signer New quote signer address.
    function setQuoteSigner(address _signer) external onlyOwner {
        address previousSigner = quoteSigner;
        quoteSigner = _signer;

        emit QuoteSignerUpdated(previousSigner, _signer);
    }

    /// @notice Updates quote guardrails enforced during validation.
    /// @param _maxVerificationGasLimit Maximum verification gas limit accepted.
    /// @param _maxPostOpOverheadGas Maximum signed `postOpOverheadGas`.
    /// @param _maxNativeCostWei Maximum native `maxCost` accepted from EntryPoint.
    /// @param _maxQuoteTtlSeconds Maximum signed quote lifetime.
    /// @param _maxSurchargeBps Maximum signed surcharge.
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
    /// @dev For USDC, the owner may only withdraw balances above `lockedUsdcPrefund`.
    /// @param _token ERC-20 token to withdraw.
    /// @param _to Recipient address.
    /// @param _amount Token amount to withdraw.
    function withdrawToken(address _token, address _to, uint256 _amount) external onlyOwner {
        if (_token == address(usdc)) {
            uint256 availableUsdc = usdc.balanceOf(address(this)) - lockedUsdcPrefund;
            if (_amount > availableUsdc) {
                revert InsufficientUnlockedBalance();
            }
        }

        IERC20(_token).safeTransfer(_to, _amount);
    }

    /// @notice Returns the EIP-712 digest for a sponsored user operation quote.
    /// @param _userOp Packed user operation.
    /// @param _quote Signed quote data carried in `paymasterData`.
    /// @return digest_ EIP-712 digest that must be signed by `quoteSigner`.
    function quoteHash(
        PackedUserOperation calldata _userOp,
        QuoteData calldata _quote
    ) external view returns (bytes32 digest_) {
        return _hashTypedDataV4(_hashSponsoredUserOperation(_userOp, _quote));
    }

    // ---------------------------------------------------------------
    // Internal Functions
    // ---------------------------------------------------------------

    /// @dev Validates quote terms, optionally applies a bundled permit, and locks USDC for later settlement.
    function _validatePaymasterUserOp(
        PackedUserOperation calldata _userOp,
        bytes32 _userOpHash,
        uint256 _maxCost
    ) internal override returns (bytes memory context_, uint256 validationData_) {
        if (quoteSigner == address(0)) {
            revert QuoteSignerDisabled();
        }

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
        if (!SignatureChecker.isValidSignatureNow(quoteSigner, signedQuoteHash, quoteSignature)) {
            revert InvalidQuoteSignature();
        }

        uint256 requiredPrefund = _applySurcharge((_maxCost * quote.exchangeRate) / _WEI_PER_ETH, quote.surchargeBps);
        if (requiredPrefund > quote.maxTokenCost) {
            revert MaxCostExceeded();
        }

        if (usdc.allowance(_userOp.sender, address(this)) < quote.maxTokenCost) {
            _tryPermit(_userOp.sender, permitData);

            if (usdc.allowance(_userOp.sender, address(this)) < quote.maxTokenCost) {
                revert InsufficientAllowance();
            }
        }

        if (usdc.balanceOf(_userOp.sender) < quote.maxTokenCost) {
            revert InsufficientBalance();
        }

        usdc.safeTransferFrom(_userOp.sender, address(this), quote.maxTokenCost);
        lockedUsdcPrefund += quote.maxTokenCost;

        context_ = abi.encode(
            PaymasterContext({
                sender: _userOp.sender,
                userOpHash: _userOpHash,
                prefund: quote.maxTokenCost,
                exchangeRate: quote.exchangeRate,
                postOpOverheadGas: quote.postOpOverheadGas,
                surchargeBps: quote.surchargeBps
            })
        );

        validationData_ = _packValidationData(false, quote.validUntil, quote.validAfter);
    }

    /// @dev Settles the final USDC cost after execution and refunds any unused prefund.
    function _postOp(
        PostOpMode _mode,
        bytes calldata _context,
        uint256 _actualGasCost,
        uint256 _actualUserOpFeePerGas
    ) internal override {
        PaymasterContext memory ctx = abi.decode(_context, (PaymasterContext));

        uint256 nativeCostWithOverhead = _actualGasCost + (_actualUserOpFeePerGas * ctx.postOpOverheadGas);
        uint256 actualTokenNeeded =
            _applySurcharge((nativeCostWithOverhead * ctx.exchangeRate) / _WEI_PER_ETH, ctx.surchargeBps);

        uint256 feeTokenAmount = ctx.prefund;
        uint256 refundAmount;

        if (_mode == PostOpMode.opSucceeded) {
            if (actualTokenNeeded < ctx.prefund) {
                refundAmount = ctx.prefund - actualTokenNeeded;
                feeTokenAmount = actualTokenNeeded;

                if (refundAmount > 0) {
                    usdc.safeTransfer(ctx.sender, refundAmount);
                }
            } else if (actualTokenNeeded > ctx.prefund) {
                uint256 shortfall = actualTokenNeeded - ctx.prefund;
                usdc.safeTransferFrom(ctx.sender, address(this), shortfall);
                feeTokenAmount = ctx.prefund + shortfall;
            }
        } else if (_mode == PostOpMode.opReverted) {
            if (actualTokenNeeded < ctx.prefund) {
                refundAmount = ctx.prefund - actualTokenNeeded;
                feeTokenAmount = actualTokenNeeded;

                if (refundAmount > 0) {
                    usdc.safeTransfer(ctx.sender, refundAmount);
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

    /// @dev Validates quote boundaries and lifetime against local guardrails.
    function _validateQuote(QuoteData memory _quote) internal view {
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

    /// @dev Attempts to grant allowance using the bundled permit.
    function _tryPermit(address _owner, PermitData memory _permit) internal {
        if (_permit.value == 0 || _permit.signature.length == 0) {
            return;
        }

        try IERC20PermitBytes(address(usdc)).permit(
            _owner,
            address(this),
            _permit.value,
            _permit.deadline,
            _permit.signature
        ) {
            return;
        } catch {}

        if (_permit.signature.length != 65) {
            return;
        }

        (uint8 v, bytes32 r, bytes32 s) = _splitSignature(_permit.signature);
        try IERC20Permit(address(usdc)).permit(_owner, address(this), _permit.value, _permit.deadline, v, r, s) {} catch {}
    }

    /// @dev Hashes the quote and user operation fields covered by the quote signer.
    function _hashSponsoredUserOperation(
        PackedUserOperation calldata _userOp,
        QuoteData memory _quote
    ) internal view returns (bytes32 structHash_) {
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
                _quote.postOpOverheadGas,
                _quote.surchargeBps,
                block.chainid,
                address(this)
            )
        );
    }

    /// @dev Applies a surcharge using ceiling division so the paymaster never under-collects.
    function _applySurcharge(uint256 _amount, uint256 _surchargeBps) internal pure returns (uint256) {
        if (_amount == 0) {
            return 0;
        }

        return ((_amount * (_BASIS_POINTS_SCALE + _surchargeBps)) + (_BASIS_POINTS_SCALE - 1)) / _BASIS_POINTS_SCALE;
    }

    /// @dev Validates owner-configurable guardrails.
    function _validateLimits(
        uint256 _maxVerificationGasLimit,
        uint256 _maxPostOpOverheadGas,
        uint256 _maxNativeCostWei,
        uint256 _maxQuoteTtlSeconds,
        uint256 _maxSurchargeBps
    ) internal pure {
        if (
            _maxVerificationGasLimit == 0 ||
            _maxPostOpOverheadGas > _MAX_POST_OP_OVERHEAD_GAS ||
            _maxNativeCostWei == 0 ||
            _maxQuoteTtlSeconds == 0 ||
            _maxSurchargeBps > _BASIS_POINTS_SCALE
        ) {
            revert InvalidLimits();
        }
    }

    /// @dev Converts a 65-byte signature into `v`, `r`, `s` components for ERC-2612 fallback.
    function _splitSignature(bytes memory _signature) internal pure returns (uint8 v_, bytes32 r_, bytes32 s_) {
        assembly ("memory-safe") {
            r_ := mload(add(_signature, 0x20))
            s_ := mload(add(_signature, 0x40))
            v_ := byte(0, mload(add(_signature, 0x60)))
        }

        if (v_ < 27) {
            v_ += 27;
        }
    }

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error InvalidPaymasterData();
    error InvalidQuoteToken();
    error InvalidQuoteExchangeRate();
    error InvalidQuoteMaxTokenCost();
    error QuoteExpired();
    error QuoteTtlTooLong();
    error InvalidQuoteSignature();
    error QuotePostOpOverheadTooHigh();
    error QuoteSignerDisabled();
    error GasLimitTooHigh();
    error MaxCostExceeded();
    error InsufficientAllowance();
    error InsufficientBalance();
    error InvalidAddress();
    error InvalidBps();
    error InvalidLimits();
    error InsufficientUnlockedBalance();
}
