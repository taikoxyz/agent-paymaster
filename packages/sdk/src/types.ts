export type HexString = `0x${string}`;
export type Address = `0x${string}`;

export type ChainName = "taikoMainnet" | "taikoHekla" | "taikoHoodi";

export interface QuoteRequest {
  sender?: Address;
  chain?: ChainName | number | `${number}`;
  chainId?: number;
  entryPoint: Address;
  token?: "USDC";
  userOperation: Record<string, unknown>;
}

export interface QuoteResponse {
  quoteId: string;
  chain: ChainName;
  chainId: number;
  token: "USDC";
  paymaster: Address;
  paymasterData: HexString;
  paymasterAndData: HexString;
  callGasLimit: HexString;
  verificationGasLimit: HexString;
  preVerificationGas: HexString;
  paymasterVerificationGasLimit: HexString;
  paymasterPostOpGasLimit: HexString;
  estimatedGasLimit: HexString;
  estimatedGasWei: HexString;
  maxTokenCostMicros: string;
  maxTokenCost: string;
  validUntil: number;
  entryPoint: Address;
  sender: Address;
  tokenAddress: Address;
  supportedTokens: readonly ["USDC"] | "USDC"[];
}

export interface PaymasterRpcResult {
  paymaster: Address;
  paymasterData: HexString;
  paymasterAndData: HexString;
  callGasLimit: HexString;
  verificationGasLimit: HexString;
  preVerificationGas: HexString;
  paymasterVerificationGasLimit: HexString;
  paymasterPostOpGasLimit: HexString;
  quoteId: string;
  token: "USDC";
  tokenAddress: Address;
  maxTokenCost: string;
  maxTokenCostMicros: string;
  validUntil: number;
  isStub: boolean;
}

export interface BundledPermitData {
  value: bigint | number | `${number}`;
  deadline: bigint | number | `${number}`;
  signature: HexString;
}

export interface RateLimitErrorPayload {
  limit: number;
  resetAt: number;
}

export interface ServoClientConfig {
  apiUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}
