import type { Address, HexString } from "./types.js";
import { AgentPaymasterSdkError } from "./errors.js";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HEX_BYTES_PATTERN = /^0x(?:[a-fA-F0-9]{2})*$/;

const PERMIT_TYPE = [
  { name: "owner", type: "address" },
  { name: "spender", type: "address" },
  { name: "value", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

interface PermitDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

interface PermitMessage {
  owner: Address;
  spender: Address;
  value: string;
  nonce: string;
  deadline: string;
}

export interface PermitTypedData {
  domain: PermitDomain;
  types: {
    Permit: typeof PERMIT_TYPE;
  };
  primaryType: "Permit";
  message: PermitMessage;
}

export interface BuildPermitRequest {
  owner: Address;
  spender: Address;
  value: bigint | number | `${number}`;
  nonce: bigint | number | `${number}`;
  deadline: bigint | number | `${number}`;
  tokenAddress: Address;
  chainId: number;
  tokenName?: string;
  tokenVersion?: string;
}

export interface PermitSignature {
  typedData: PermitTypedData;
  signature: HexString;
  value: bigint;
  deadline: bigint;
}

export type PermitSigner = (typedData: PermitTypedData) => Promise<HexString>;

const normalizeAddress = (value: string, fieldName: string): Address => {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new AgentPaymasterSdkError("invalid_address", `${fieldName} must be a valid address`);
  }

  return value as Address;
};

const toDecimalString = (
  value: bigint | number | `${number}`,
  fieldName: string,
  allowZero = true,
): string => {
  let parsed: bigint;

  try {
    parsed = BigInt(value);
  } catch {
    throw new AgentPaymasterSdkError("invalid_number", `${fieldName} must be an integer value`);
  }

  if (parsed < 0n || (!allowZero && parsed === 0n)) {
    throw new AgentPaymasterSdkError("invalid_number", `${fieldName} must be non-negative`);
  }

  return parsed.toString();
};

export const buildPermitTypedData = (request: BuildPermitRequest): PermitTypedData => ({
  domain: {
    name: request.tokenName ?? "USD Coin",
    version: request.tokenVersion ?? "2",
    chainId: request.chainId,
    verifyingContract: normalizeAddress(request.tokenAddress, "tokenAddress"),
  },
  types: {
    Permit: PERMIT_TYPE,
  },
  primaryType: "Permit",
  message: {
    owner: normalizeAddress(request.owner, "owner"),
    spender: normalizeAddress(request.spender, "spender"),
    value: toDecimalString(request.value, "value", false),
    nonce: toDecimalString(request.nonce, "nonce"),
    deadline: toDecimalString(request.deadline, "deadline"),
  },
});

const normalizeHexBytes = (
  value: string,
  fieldName: string,
  { allowEmpty = true }: { allowEmpty?: boolean } = {},
): HexString => {
  if (!HEX_BYTES_PATTERN.test(value)) {
    throw new AgentPaymasterSdkError(
      "invalid_hex",
      `${fieldName} must be a hex string`,
    );
  }

  if (!allowEmpty && value === "0x") {
    throw new AgentPaymasterSdkError("invalid_signature", `${fieldName} cannot be empty`);
  }

  return value.toLowerCase() as HexString;
};

export const createPermitSignature = async (
  request: BuildPermitRequest,
  signer: PermitSigner,
): Promise<PermitSignature> => {
  const typedData = buildPermitTypedData(request);

  const signature = await signer(typedData);
  const value = BigInt(typedData.message.value);
  const deadline = BigInt(typedData.message.deadline);

  return {
    typedData,
    signature: normalizeHexBytes(signature, "signature", { allowEmpty: false }),
    value,
    deadline,
  };
};
