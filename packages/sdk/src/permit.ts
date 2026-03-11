import type { Address, HexString } from "./types.js";
import { AgentPaymasterSdkError } from "./errors.js";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE_PATTERN = /^0x[a-fA-F0-9]{130}$/;

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
  v: number;
  r: HexString;
  s: HexString;
}

export type PermitSigner = (typedData: PermitTypedData) => Promise<HexString>;

const normalizeAddress = (value: string, fieldName: string): Address => {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new AgentPaymasterSdkError("invalid_address", `${fieldName} must be a valid address`);
  }

  return value.toLowerCase() as Address;
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

const splitSignature = (signature: HexString): Pick<PermitSignature, "v" | "r" | "s"> => {
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new AgentPaymasterSdkError(
      "invalid_signature",
      "Permit signer must return a 65-byte hex signature",
    );
  }

  const r = `0x${signature.slice(2, 66)}` as HexString;
  const s = `0x${signature.slice(66, 130)}` as HexString;
  const vRaw = Number.parseInt(signature.slice(130, 132), 16);
  const v = vRaw >= 27 ? vRaw : vRaw + 27;

  return { v, r, s };
};

export const createPermitSignature = async (
  request: BuildPermitRequest,
  signer: PermitSigner,
): Promise<PermitSignature> => {
  const typedData = buildPermitTypedData(request);

  const signature = await signer(typedData);

  return {
    typedData,
    signature,
    ...splitSignature(signature),
  };
};
