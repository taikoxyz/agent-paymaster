import { decodeAbiParameters, encodeAbiParameters } from "viem";

import { ServoError } from "./errors.js";
import type {
  Address,
  BundledPermitData,
  HexString,
  PaymasterRpcResult,
  QuoteResponse,
} from "./types.js";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HEX_BYTES_PATTERN = /^0x(?:[a-fA-F0-9]{2})*$/;
const UINT128_MAX = (1n << 128n) - 1n;

/**
 * ABI layout of the Servo paymaster's `paymasterData` field.
 * This is the contract-level encoding that must be preserved exactly.
 */
const PAYMASTER_DATA_PARAMETERS = [
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

interface DecodedQuoteData {
  token: Address;
  exchangeRate: bigint;
  maxTokenCost: bigint;
  validAfter: number;
  validUntil: number;
  postOpOverheadGas: number;
  surchargeBps: number;
}

interface DecodedPermitData {
  value: bigint;
  deadline: bigint;
  signature: HexString;
}

// ── Inline helpers (avoid @agent-paymaster/shared dependency) ──

const normalizeAddress = (value: string, fieldName: string): Address => {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new ServoError("invalid_address", `${fieldName} must be a valid address`);
  }
  return value.toLowerCase() as Address;
};

const normalizeHexBytes = (
  value: string,
  fieldName: string,
  { allowEmpty = true }: { allowEmpty?: boolean } = {},
): HexString => {
  if (!HEX_BYTES_PATTERN.test(value)) {
    throw new ServoError("invalid_hex", `${fieldName} must be a hex string`);
  }
  if (!allowEmpty && value === "0x") {
    throw new ServoError("invalid_signature", `${fieldName} cannot be empty`);
  }
  return value.toLowerCase() as HexString;
};

const toUint128Hex = (value: bigint, fieldName: string): string => {
  if (value < 0n || value > UINT128_MAX) {
    throw new ServoError("invalid_number", `${fieldName} exceeds uint128`);
  }
  return value.toString(16).padStart(32, "0");
};

const packPaymasterAndData = (
  paymaster: Address,
  verificationGasLimit: bigint,
  postOpGasLimit: bigint,
  paymasterData: HexString,
): HexString =>
  `${normalizeAddress(paymaster, "paymaster")}${toUint128Hex(
    verificationGasLimit,
    "paymasterVerificationGasLimit",
  )}${toUint128Hex(postOpGasLimit, "paymasterPostOpGasLimit")}${normalizeHexBytes(
    paymasterData,
    "paymasterData",
  ).slice(2)}` as HexString;

const toBigIntValue = (
  value: bigint | number | `${number}`,
  fieldName: string,
  { allowZero = true }: { allowZero?: boolean } = {},
): bigint => {
  let parsed: bigint;

  try {
    parsed = BigInt(value);
  } catch {
    throw new ServoError("invalid_number", `${fieldName} must be an integer value`);
  }

  if (parsed < 0n || (!allowZero && parsed === 0n)) {
    throw new ServoError("invalid_number", `${fieldName} must be non-negative`);
  }

  return parsed;
};

// ── Public API ──

/**
 * Injects a signed EIP-2612 permit into a Servo quote's `paymasterData`.
 *
 * The Servo paymaster contract expects `paymasterData` to be ABI-encoded as
 * `(QuoteStruct, quoteSignature, PermitStruct)`. The quote API returns this
 * with an empty permit stub. This function decodes the data, replaces the
 * stub with your actual permit, and re-encodes it.
 *
 * @param quote - A `QuoteResponse` from `ServoClient.getUsdcQuote()` or a
 *   `PaymasterRpcResult` from the `pm_getPaymasterData` RPC method.
 * @param permit - The signed permit data: `value`, `deadline`, and `signature`.
 * @returns A new quote object with updated `paymasterData` and `paymasterAndData`.
 */
export const applyPermitToPaymasterQuote = <TQuote extends QuoteResponse | PaymasterRpcResult>(
  quote: TQuote,
  permit: BundledPermitData,
): TQuote => {
  const paymaster = normalizeAddress(quote.paymaster, "quote.paymaster");
  const paymasterData = normalizeHexBytes(quote.paymasterData, "quote.paymasterData");

  const [quoteData, quoteSignature] = decodeAbiParameters(
    PAYMASTER_DATA_PARAMETERS,
    paymasterData,
  ) as [DecodedQuoteData, HexString, DecodedPermitData];

  if (normalizeAddress(quoteData.token, "quoteData.token") !== quote.tokenAddress.toLowerCase()) {
    throw new ServoError(
      "invalid_paymaster_data",
      "Quote token in paymasterData does not match quote.tokenAddress",
    );
  }

  const normalizedPermit: DecodedPermitData = {
    value: toBigIntValue(permit.value, "permit.value", { allowZero: false }),
    deadline: toBigIntValue(permit.deadline, "permit.deadline"),
    signature: normalizeHexBytes(permit.signature, "permit.signature", { allowEmpty: false }),
  };

  const minPermitValue = BigInt(quote.maxTokenCostMicros);
  if (normalizedPermit.value < minPermitValue) {
    throw new ServoError(
      "invalid_number",
      "permit.value must cover at least quote.maxTokenCostMicros",
    );
  }

  const nextPaymasterData = encodeAbiParameters(PAYMASTER_DATA_PARAMETERS, [
    quoteData,
    quoteSignature,
    normalizedPermit,
  ]) as HexString;

  return {
    ...quote,
    paymasterData: nextPaymasterData,
    paymasterAndData: packPaymasterAndData(
      paymaster,
      BigInt(quote.paymasterVerificationGasLimit),
      BigInt(quote.paymasterPostOpGasLimit),
      nextPaymasterData,
    ),
  };
};
