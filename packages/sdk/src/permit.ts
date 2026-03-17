import type { LocalAccount } from "viem/accounts";

import { AgentPaymasterSdkError } from "./errors.js";
import type { Address, HexString, PermitContext } from "./types.js";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

const PERMIT_TYPE = [
  { name: "owner", type: "address" },
  { name: "spender", type: "address" },
  { name: "value", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

export interface PermitTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: {
    Permit: typeof PERMIT_TYPE;
  };
  primaryType: "Permit";
  message: {
    owner: Address;
    spender: Address;
    value: bigint;
    nonce: bigint;
    deadline: bigint;
  };
}

export interface SignPermitInput {
  account: LocalAccount;
  owner: Address;
  spender: Address;
  tokenAddress: Address;
  chainId: number;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
  tokenName?: string;
  tokenVersion?: string;
}

export interface SignedPermit {
  typedData: PermitTypedData;
  signature: HexString;
  context: PermitContext;
}

const normalizeAddress = (value: string, fieldName: string): Address => {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new AgentPaymasterSdkError("invalid_address", `${fieldName} must be a valid address`);
  }

  return value as Address;
};

const normalizeUint = (value: bigint, fieldName: string): bigint => {
  if (value < 0n) {
    throw new AgentPaymasterSdkError("invalid_number", `${fieldName} must be non-negative`);
  }

  return value;
};

export const buildPermitTypedData = (input: Omit<SignPermitInput, "account">): PermitTypedData => ({
  domain: {
    name: input.tokenName ?? "USD Coin",
    version: input.tokenVersion ?? "2",
    chainId: input.chainId,
    verifyingContract: normalizeAddress(input.tokenAddress, "tokenAddress"),
  },
  types: {
    Permit: PERMIT_TYPE,
  },
  primaryType: "Permit",
  message: {
    owner: normalizeAddress(input.owner, "owner"),
    spender: normalizeAddress(input.spender, "spender"),
    value: normalizeUint(input.value, "value"),
    nonce: normalizeUint(input.nonce, "nonce"),
    deadline: normalizeUint(input.deadline, "deadline"),
  },
});

export const signPermit = async (input: SignPermitInput): Promise<SignedPermit> => {
  const typedData = buildPermitTypedData(input);

  const signature = (await input.account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  })) as HexString;

  return {
    typedData,
    signature,
    context: {
      value: typedData.message.value.toString(),
      deadline: typedData.message.deadline.toString(),
      signature,
    },
  };
};
