import { type Address, type Hex, isAddress } from "viem";
import type { LocalAccount } from "viem/accounts";

import type { PermitContext } from "./types.js";

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
  signature: Hex;
  context: PermitContext;
}

const assertAddress = (value: string, fieldName: string): Address => {
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${fieldName} must be a valid address`);
  }

  return value.toLowerCase() as Address;
};

const assertNonNegative = (value: bigint, fieldName: string): bigint => {
  if (value < 0n) {
    throw new Error(`${fieldName} must be non-negative`);
  }

  return value;
};

export const buildPermitTypedData = (input: Omit<SignPermitInput, "account">): PermitTypedData => ({
  domain: {
    name: input.tokenName ?? "USD Coin",
    version: input.tokenVersion ?? "2",
    chainId: input.chainId,
    verifyingContract: assertAddress(input.tokenAddress, "tokenAddress"),
  },
  types: {
    Permit: PERMIT_TYPE,
  },
  primaryType: "Permit",
  message: {
    owner: assertAddress(input.owner, "owner"),
    spender: assertAddress(input.spender, "spender"),
    value: assertNonNegative(input.value, "value"),
    nonce: assertNonNegative(input.nonce, "nonce"),
    deadline: assertNonNegative(input.deadline, "deadline"),
  },
});

export const signPermit = async (input: SignPermitInput): Promise<SignedPermit> => {
  const typedData = buildPermitTypedData(input);

  const signature = (await input.account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  })) as Hex;

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
