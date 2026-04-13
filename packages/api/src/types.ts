export {
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcErrorObject,
  type JsonRpcSuccess,
  type JsonRpcFailure,
  type JsonRpcResponse,
  isJsonRpcFailure,
  makeJsonRpcError,
  isJsonRpcRequest,
  isObject,
} from "@agent-paymaster/shared";

export interface DependencyHealth {
  status: "ok" | "degraded";
  latencyMs: number;
  details?: unknown;
  error?: string;
}
