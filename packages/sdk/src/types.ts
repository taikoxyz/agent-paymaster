import type { Address, Hex } from "viem";

export type ChainName = "taikoMainnet" | "taikoHekla" | "taikoHoodi";

export interface ServoCall {
  target: Address;
  value?: bigint;
  data: Hex;
}

export interface PermitContext {
  value: string;
  deadline: string;
  signature: Hex;
}

/** Servo-specific response from pm_getPaymasterData / pm_getPaymasterStubData. */
export interface PaymasterQuote {
  paymaster: Address;
  paymasterData: Hex;
  paymasterAndData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  paymasterVerificationGasLimit: Hex;
  paymasterPostOpGasLimit: Hex;
  quoteId: string;
  token: "USDC";
  tokenAddress: Address;
  maxTokenCost: string;
  maxTokenCostMicros: string;
  validUntil: number;
  isStub: boolean;
}

export interface CreateAndExecuteResult {
  counterfactualAddress: Address;
  quote: PaymasterQuote;
  permit: PermitContext;
  userOperationHash: Hex;
}
