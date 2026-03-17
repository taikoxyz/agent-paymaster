export type HexString = `0x${string}`;
export type Address = `0x${string}`;
export type JsonRpcId = string | number | null;

export type ChainName = "taikoMainnet" | "taikoHekla" | "taikoHoodi";

export interface UserOperation {
  sender: Address;
  nonce: HexString;
  initCode: HexString;
  callData: HexString;
  callGasLimit?: HexString;
  verificationGasLimit?: HexString;
  preVerificationGas?: HexString;
  paymasterVerificationGasLimit?: HexString;
  paymasterPostOpGasLimit?: HexString;
  maxFeePerGas: HexString;
  maxPriorityFeePerGas: HexString;
  paymasterAndData?: HexString;
  signature: HexString;
  l1DataGas?: HexString;
}

export interface UserOperationGasEstimate {
  callGasLimit: HexString;
  verificationGasLimit: HexString;
  preVerificationGas: HexString;
  paymasterVerificationGasLimit: HexString;
  paymasterPostOpGasLimit: HexString;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcFailure;

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

export interface RateLimitErrorPayload {
  limit: number;
  resetAt: number;
}

export interface TransportConfig {
  rpcUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

export interface BuildUserOperationInput {
  sender: Address;
  nonce: HexString;
  callData: HexString;
  maxFeePerGas: HexString;
  maxPriorityFeePerGas: HexString;
  signature?: HexString;
  initCode?: HexString;
  callGasLimit?: HexString;
  verificationGasLimit?: HexString;
  preVerificationGas?: HexString;
  paymasterVerificationGasLimit?: HexString;
  paymasterPostOpGasLimit?: HexString;
  paymasterAndData?: HexString;
  l1DataGas?: HexString;
}

export interface ServoCall {
  target: Address;
  value?: bigint;
  data: HexString;
}

export interface PermitContext {
  value: string;
  deadline: string;
  signature: HexString;
}

export interface CreateAndExecuteResult {
  counterfactualAddress: Address;
  quote: PaymasterRpcResult;
  permit: PermitContext;
  userOperation: UserOperation;
  userOperationHash: HexString;
}
