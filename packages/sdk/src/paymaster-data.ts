import { decodeAbiParameters, encodeAbiParameters } from "viem";

import { AgentPaymasterSdkError } from "./errors.js";
import type { PermitSignature } from "./permit.js";
import type { Address, HexString, PaymasterRpcResult, QuoteResponse } from "./types.js";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HEX_BYTES_PATTERN = /^0x(?:[a-fA-F0-9]{2})*$/;

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

interface PaymasterQuoteLike {
  paymaster: Address;
  paymasterData: HexString;
  paymasterAndData: HexString;
  tokenAddress: Address;
  maxTokenCostMicros: string;
}

export interface BundledPermitData {
  value: bigint | number | `${number}`;
  deadline: bigint | number | `${number}`;
  signature: HexString;
}

const normalizeAddress = (value: string, fieldName: string): Address => {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new AgentPaymasterSdkError("invalid_address", `${fieldName} must be a valid address`);
  }

  return value as Address;
};

const normalizeHexBytes = (
  value: string,
  fieldName: string,
  { allowEmpty = true }: { allowEmpty?: boolean } = {},
): HexString => {
  if (!HEX_BYTES_PATTERN.test(value)) {
    throw new AgentPaymasterSdkError("invalid_hex", `${fieldName} must be a hex string`);
  }

  if (!allowEmpty && value === "0x") {
    throw new AgentPaymasterSdkError("invalid_signature", `${fieldName} cannot be empty`);
  }

  return value.toLowerCase() as HexString;
};

const toBigIntValue = (
  value: bigint | number | `${number}`,
  fieldName: string,
  { allowZero = true }: { allowZero?: boolean } = {},
): bigint => {
  let parsed: bigint;

  try {
    parsed = BigInt(value);
  } catch {
    throw new AgentPaymasterSdkError("invalid_number", `${fieldName} must be an integer value`);
  }

  if (parsed < 0n || (!allowZero && parsed === 0n)) {
    throw new AgentPaymasterSdkError("invalid_number", `${fieldName} must be non-negative`);
  }

  return parsed;
};

const normalizeBundledPermit = (
  permit: BundledPermitData | PermitSignature,
  quote: PaymasterQuoteLike,
): DecodedPermitData => {
  const normalized = {
    value: toBigIntValue(permit.value, "permit.value", { allowZero: false }),
    deadline: toBigIntValue(permit.deadline, "permit.deadline"),
    signature: normalizeHexBytes(permit.signature, "permit.signature", { allowEmpty: false }),
  } satisfies DecodedPermitData;

  const minPermitValue = BigInt(quote.maxTokenCostMicros);
  if (normalized.value < minPermitValue) {
    throw new AgentPaymasterSdkError(
      "invalid_number",
      "permit.value must cover at least quote.maxTokenCostMicros",
    );
  }

  if ("typedData" in permit) {
    const spender = normalizeAddress(permit.typedData.message.spender, "typedData.message.spender");
    const verifyingContract = normalizeAddress(
      permit.typedData.domain.verifyingContract,
      "typedData.domain.verifyingContract",
    );

    if (spender.toLowerCase() !== quote.paymaster.toLowerCase()) {
      throw new AgentPaymasterSdkError(
        "invalid_paymaster_data",
        "Permit spender does not match the paymaster address",
      );
    }

    if (verifyingContract.toLowerCase() !== quote.tokenAddress.toLowerCase()) {
      throw new AgentPaymasterSdkError(
        "invalid_paymaster_data",
        "Permit verifyingContract does not match the quote token address",
      );
    }
  }

  return normalized;
};

export const applyPermitToPaymasterQuote = <
  TQuote extends QuoteResponse | PaymasterRpcResult,
>(
  quote: TQuote,
  permit: BundledPermitData | PermitSignature,
): TQuote => {
  const paymaster = normalizeAddress(quote.paymaster, "quote.paymaster");
  const paymasterData = normalizeHexBytes(quote.paymasterData, "quote.paymasterData");

  const [quoteData, quoteSignature] = decodeAbiParameters(PAYMASTER_DATA_PARAMETERS, paymasterData) as [
    DecodedQuoteData,
    HexString,
    DecodedPermitData,
  ];

  if (normalizeAddress(quoteData.token, "quoteData.token").toLowerCase() !== quote.tokenAddress.toLowerCase()) {
    throw new AgentPaymasterSdkError(
      "invalid_paymaster_data",
      "Quote token in paymasterData does not match quote.tokenAddress",
    );
  }

  const nextPermit = normalizeBundledPermit(permit, quote);
  const nextPaymasterData = encodeAbiParameters(PAYMASTER_DATA_PARAMETERS, [
    quoteData,
    quoteSignature,
    nextPermit,
  ]) as HexString;

  return {
    ...quote,
    paymasterData: nextPaymasterData,
    paymasterAndData: `${paymaster}${nextPaymasterData.slice(2)}` as HexString,
  };
};
