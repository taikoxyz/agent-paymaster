import { encodeAbiParameters, keccak256 } from "viem";

export { logEvent, type LogLevel, type LogFields } from "./logger.js";
export {
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcErrorObject,
  type JsonRpcSuccess,
  type JsonRpcFailure,
  type JsonRpcResponse,
  isJsonRpcFailure,
  makeJsonRpcError,
  makeJsonRpcResult,
  isJsonRpcId,
  isJsonRpcRequest,
  isObject,
} from "./json-rpc.js";

export type ChainName = "taikoMainnet" | "taikoHoodi";
export type HexString = `0x${string}`;
export type Address = `0x${string}`;

/** Canonical v0.7 EntryPoint for Servo's Taiko ERC-4337 flow. */
export const SERVO_TAIKO_ENTRY_POINT_V07: Address = "0x0000000071727de22e5e9d8baf0edac6f37da032";

/** EntryPoints Servo can actually execute through the configured paymaster path. */
export const SERVO_SUPPORTED_ENTRY_POINTS = [SERVO_TAIKO_ENTRY_POINT_V07] as const;

export interface ServiceHealth {
  service: string;
  status: "ok" | "degraded";
  timestamp: string;
}

export const buildHealth = (service: string): ServiceHealth => ({
  service,
  status: "ok",
  timestamp: new Date().toISOString(),
});

/**
 * Constants for Servo's ERC-20 mode paymasterData, laid out exactly as Pimlico's SingletonPaymasterV7
 * parses them. See `src/pimlico/SingletonPaymasterV7.sol` for the byte-level layout.
 */
export const SERVO_PAYMASTER_MODE_ERC20 = 1;

/**
 * Fixed size in bytes of the ERC-20 paymaster config (mode byte + flags byte + fixed 117-byte config),
 * excluding the trailing signature.
 */
export const SERVO_ERC20_PAYMASTER_DATA_NO_SIG_LENGTH = 118;

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HEX_BYTES_PATTERN = /^0x(?:[a-fA-F0-9]{2})*$/;
const UINT128_MAX = (1n << 128n) - 1n;

const PAYMASTER_ADDRESS_END = 42;
const PAYMASTER_VALIDATION_GAS_END = 74;
const PAYMASTER_POST_OP_GAS_END = 106;

const normalizeAddress = (value: string, fieldName: string): Address => {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be a valid address`);
  }

  return value.toLowerCase() as Address;
};

const normalizeHexBytes = (value: string, fieldName: string): HexString => {
  if (!HEX_BYTES_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be a hex byte string`);
  }

  return value.toLowerCase() as HexString;
};

const toUint128Hex = (value: bigint, fieldName: string): string => {
  if (value < 0n || value > UINT128_MAX) {
    throw new Error(`${fieldName} exceeds uint128`);
  }

  return value.toString(16).padStart(32, "0");
};

const fromUint128Hex = (value: string): bigint => BigInt(`0x${value}`);

export interface PackPaymasterAndDataInput {
  paymaster: Address;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  paymasterData: HexString;
}

export interface NormalizedPaymasterAndData {
  paymaster: Address;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  paymasterData: HexString;
  paymasterAndData: HexString;
  inputFormat: "packed" | "legacy";
}

export const packPaymasterAndData = ({
  paymaster,
  paymasterVerificationGasLimit,
  paymasterPostOpGasLimit,
  paymasterData,
}: PackPaymasterAndDataInput): HexString =>
  `${normalizeAddress(paymaster, "paymaster")}${toUint128Hex(
    paymasterVerificationGasLimit,
    "paymasterVerificationGasLimit",
  )}${toUint128Hex(paymasterPostOpGasLimit, "paymasterPostOpGasLimit")}${normalizeHexBytes(
    paymasterData,
    "paymasterData",
  ).slice(2)}` as HexString;

export interface NormalizePaymasterAndDataInput {
  paymasterAndData: HexString;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
}

export const normalizePaymasterAndData = ({
  paymasterAndData,
  paymasterVerificationGasLimit,
  paymasterPostOpGasLimit,
}: NormalizePaymasterAndDataInput): NormalizedPaymasterAndData => {
  const normalized = normalizeHexBytes(paymasterAndData, "paymasterAndData");
  if (normalized === "0x") {
    throw new Error("paymasterAndData must not be empty");
  }

  if (normalized.length < PAYMASTER_ADDRESS_END) {
    throw new Error("paymasterAndData must include a paymaster address prefix");
  }

  const paymaster = normalizeAddress(
    normalized.slice(0, PAYMASTER_ADDRESS_END),
    "paymasterAndData",
  );
  const hasPackedStaticFields = normalized.length >= PAYMASTER_POST_OP_GAS_END;

  if (paymasterVerificationGasLimit === undefined || paymasterPostOpGasLimit === undefined) {
    if (!hasPackedStaticFields) {
      throw new Error(
        "paymaster gas limits are required when paymasterAndData does not include packed gas fields",
      );
    }

    const verificationGasHex = normalized.slice(
      PAYMASTER_ADDRESS_END,
      PAYMASTER_VALIDATION_GAS_END,
    );
    const postOpGasHex = normalized.slice(PAYMASTER_VALIDATION_GAS_END, PAYMASTER_POST_OP_GAS_END);

    return {
      paymaster,
      paymasterVerificationGasLimit: fromUint128Hex(verificationGasHex),
      paymasterPostOpGasLimit: fromUint128Hex(postOpGasHex),
      paymasterData: `0x${normalized.slice(PAYMASTER_POST_OP_GAS_END)}` as HexString,
      paymasterAndData: normalized,
      inputFormat: "packed",
    };
  }

  const expectedVerificationGasHex = toUint128Hex(
    paymasterVerificationGasLimit,
    "paymasterVerificationGasLimit",
  );
  const expectedPostOpGasHex = toUint128Hex(paymasterPostOpGasLimit, "paymasterPostOpGasLimit");

  const isPackedInput =
    hasPackedStaticFields &&
    normalized.slice(PAYMASTER_ADDRESS_END, PAYMASTER_VALIDATION_GAS_END) ===
      expectedVerificationGasHex &&
    normalized.slice(PAYMASTER_VALIDATION_GAS_END, PAYMASTER_POST_OP_GAS_END) ===
      expectedPostOpGasHex;

  const paymasterData = (
    isPackedInput
      ? `0x${normalized.slice(PAYMASTER_POST_OP_GAS_END)}`
      : `0x${normalized.slice(PAYMASTER_ADDRESS_END)}`
  ) as HexString;

  return {
    paymaster,
    paymasterVerificationGasLimit,
    paymasterPostOpGasLimit,
    paymasterData,
    paymasterAndData: packPaymasterAndData({
      paymaster,
      paymasterVerificationGasLimit,
      paymasterPostOpGasLimit,
      paymasterData,
    }),
    inputFormat: isPackedInput ? "packed" : "legacy",
  };
};

// ---------------------------------------------------------------
// Servo ERC-20 mode paymaster encoding (Pimlico SingletonPaymasterV7)
// ---------------------------------------------------------------

const UINT48_MAX = (1n << 48n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

const toHexPadded = (value: bigint, byteSize: number, fieldName: string): string => {
  if (value < 0n) {
    throw new Error(`${fieldName} must be non-negative`);
  }
  const maxValue = (1n << BigInt(byteSize * 8)) - 1n;
  if (value > maxValue) {
    throw new Error(`${fieldName} exceeds uint${byteSize * 8}`);
  }

  return value.toString(16).padStart(byteSize * 2, "0");
};

const stripHexPrefix = (value: string): string => (value.startsWith("0x") ? value.slice(2) : value);

/**
 * Inputs to encode a Pimlico ERC-20 mode paymaster config for Servo. Optional fields map to Pimlico's
 * preFundPresent / constantFeePresent / recipientPresent flags; Servo currently uses none of them.
 */
export interface ServoErc20PaymasterConfig {
  /** Unix timestamp after which this quote expires. 6-byte field (max 2^48 − 1). */
  validUntil: number;
  /** Unix timestamp before which this quote is not valid. 6-byte field. */
  validAfter: number;
  /** ERC-20 token the sender will pay in (USDC for Servo). */
  token: Address;
  /** Gas overhead, in gas units, used to bound the final transferFrom call. 16-byte field. */
  postOpGas: bigint;
  /** Token base units per 1 ETH (1e18 wei). See SingletonPaymasterV7.getCostInToken. */
  exchangeRate: bigint;
  /** Estimated gas used before UserOp execution (for Pimlico penalty calculation). 16-byte field. */
  paymasterValidationGasLimit: bigint;
  /** Address to receive token payments. Servo sets this to the paymaster contract itself. */
  treasury: Address;
  /** Optional: whether to permit any bundler (true) or enforce the on-chain bundler allowlist (false). */
  allowAllBundlers?: boolean;
}

/**
 * Encodes the inner paymasterConfig bytes (mode byte + flags + fixed fields) for Servo's ERC-20 mode.
 * Does NOT include the outer paymaster/gas envelope or the signature — append those separately.
 * Produces exactly 118 hex-encoded bytes.
 */
export const encodeServoErc20PaymasterConfig = (cfg: ServoErc20PaymasterConfig): HexString => {
  if (!ADDRESS_PATTERN.test(cfg.token)) {
    throw new Error("token must be a valid address");
  }
  if (!ADDRESS_PATTERN.test(cfg.treasury)) {
    throw new Error("treasury must be a valid address");
  }
  if (cfg.validUntil < 0 || BigInt(cfg.validUntil) > UINT48_MAX) {
    throw new Error("validUntil must fit in uint48");
  }
  if (cfg.validAfter < 0 || BigInt(cfg.validAfter) > UINT48_MAX) {
    throw new Error("validAfter must fit in uint48");
  }
  if (cfg.exchangeRate <= 0n || cfg.exchangeRate > UINT256_MAX) {
    throw new Error("exchangeRate must be a positive uint256");
  }

  // modeByte = (mode << 1) | allowAllBundlers
  const allowAllBundlers = cfg.allowAllBundlers ?? true;
  const modeByte = (SERVO_PAYMASTER_MODE_ERC20 << 1) | (allowAllBundlers ? 1 : 0);
  const flagsByte = 0; // no prefund / constantFee / recipient

  const parts = [
    toHexPadded(BigInt(modeByte), 1, "modeByte"),
    toHexPadded(BigInt(flagsByte), 1, "flagsByte"),
    toHexPadded(BigInt(cfg.validUntil), 6, "validUntil"),
    toHexPadded(BigInt(cfg.validAfter), 6, "validAfter"),
    stripHexPrefix(cfg.token.toLowerCase()),
    toHexPadded(cfg.postOpGas, 16, "postOpGas"),
    toHexPadded(cfg.exchangeRate, 32, "exchangeRate"),
    toHexPadded(cfg.paymasterValidationGasLimit, 16, "paymasterValidationGasLimit"),
    stripHexPrefix(cfg.treasury.toLowerCase()),
  ];

  return `0x${parts.join("")}` as HexString;
};

/** A PackedUserOperation (v0.7) slice used to compute Servo's paymaster signing hash. */
export interface ServoHashUserOp {
  sender: Address;
  nonce: bigint;
  initCode: HexString;
  callData: HexString;
  accountGasLimits: HexString;
  preVerificationGas: bigint;
  gasFees: HexString;
}

/**
 * Computes the digest that the Servo quote signer must personal_sign (EIP-191), matching
 * `SingletonPaymasterV7._getHash`. The `paymasterAndDataNoSig` input must be the full outer envelope
 * plus inner config WITHOUT the trailing signature (170 bytes for ERC-20 mode with no optional flags).
 */
export const computeServoPaymasterSigningHash = (input: {
  userOp: ServoHashUserOp;
  paymasterAndDataNoSig: HexString;
  chainId: number;
}): HexString => {
  const inner = keccak256(input.paymasterAndDataNoSig);
  const initCodeHash = keccak256(input.userOp.initCode);
  const callDataHash = keccak256(input.userOp.callData);

  const userOpHashCustom = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        input.userOp.sender,
        input.userOp.nonce,
        input.userOp.accountGasLimits as `0x${string}`,
        input.userOp.preVerificationGas,
        input.userOp.gasFees as `0x${string}`,
        initCodeHash,
        callDataHash,
        inner,
      ],
    ),
  );

  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [userOpHashCustom, BigInt(input.chainId)],
    ),
  );
};
