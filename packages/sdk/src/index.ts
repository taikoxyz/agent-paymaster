export { AgentPaymasterClient, isJsonRpcResponse } from "./client.js";
export {
  AgentPaymasterSdkError,
  HttpRequestError,
  JsonRpcRequestError,
  RateLimitError,
  TransportError,
} from "./errors.js";
export {
  buildPermitTypedData,
  createPermitSignature,
} from "./permit.js";
export { UserOperationBuilder, applyPaymasterData, buildUserOperation } from "./userop-builder.js";

export type {
  Address,
  BuildUserOperationInput,
  ChainName,
  HexString,
  JsonRpcErrorObject,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  PaymasterRpcResult,
  QuoteRequest,
  QuoteResponse,
  TransportConfig,
  UserOperation,
  UserOperationGasEstimate,
} from "./types.js";

export type {
  BuildPermitRequest,
  PermitSignature,
  PermitSigner,
  PermitTypedData,
} from "./permit.js";
