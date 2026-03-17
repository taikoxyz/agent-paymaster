export type ChainName = "taikoMainnet" | "taikoHekla" | "taikoHoodi";
export type HexString = `0x${string}`;
export type Address = `0x${string}`;

/** Canonical EntryPoint for Servo's Taiko ERC-4337 flow. */
export const SERVO_TAIKO_ENTRY_POINT_V08: Address =
  "0x0000000071727de22e5e9d8baf0edac6f37da032";

/** EntryPoints Servo can actually execute through the configured paymaster path. */
export const SERVO_SUPPORTED_ENTRY_POINTS = [SERVO_TAIKO_ENTRY_POINT_V08] as const;

export interface RpcConfig {
  chain: ChainName;
  rpcUrl: string;
}

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

/** ABI parameter layout for TaikoUsdcPaymaster paymasterData (quote + signature + permit). */
export const PAYMASTER_DATA_PARAMETERS = [
  {
    type: "tuple",
    name: "quote",
    components: [
      { name: "token", type: "address" },
      { name: "exchangeRate", type: "uint256" },
      { name: "maxTokenCost", type: "uint256" },
      { name: "validAfter", type: "uint48" },
      { name: "validUntil", type: "uint48" },
      { name: "postOpOverheadGas", type: "uint32" },
      { name: "surchargeBps", type: "uint16" },
    ],
  },
  {
    type: "bytes",
    name: "quoteSignature",
  },
  {
    type: "tuple",
    name: "permit",
    components: [
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

/** EIP-712 types for the SponsoredUserOperation quote signature. */
export const SPONSORED_USER_OPERATION_TYPES = {
  SponsoredUserOperation: [
    { name: "sender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "initCodeHash", type: "bytes32" },
    { name: "callDataHash", type: "bytes32" },
    { name: "accountGasLimits", type: "bytes32" },
    { name: "paymasterGasLimits", type: "bytes32" },
    { name: "preVerificationGas", type: "uint256" },
    { name: "gasFees", type: "bytes32" },
    { name: "token", type: "address" },
    { name: "exchangeRate", type: "uint256" },
    { name: "maxTokenCost", type: "uint256" },
    { name: "validAfter", type: "uint48" },
    { name: "validUntil", type: "uint48" },
    { name: "postOpOverheadGas", type: "uint32" },
    { name: "surchargeBps", type: "uint16" },
    { name: "chainId", type: "uint256" },
    { name: "paymaster", type: "address" },
  ],
} as const;

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
