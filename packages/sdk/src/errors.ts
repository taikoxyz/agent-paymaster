import type { JsonRpcErrorObject, RateLimitErrorPayload } from "./types.js";

export class AgentPaymasterSdkError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentPaymasterSdkError";
    this.code = code;
  }
}

export class TransportError extends AgentPaymasterSdkError {
  constructor(message: string, cause?: unknown) {
    super("transport_error", message, cause);
    this.name = "TransportError";
  }
}

export class HttpRequestError extends AgentPaymasterSdkError {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super("http_error", message);
    this.name = "HttpRequestError";
    this.status = status;
    this.payload = payload;
  }
}

export class RateLimitError extends HttpRequestError {
  readonly limit: number;
  readonly resetAt: number;

  constructor(status: number, message: string, payload: unknown, rate: RateLimitErrorPayload) {
    super(status, message, payload);
    this.name = "RateLimitError";
    this.limit = rate.limit;
    this.resetAt = rate.resetAt;
  }
}

export class JsonRpcRequestError extends AgentPaymasterSdkError {
  readonly rpcCode: number;
  readonly rpcData: unknown;
  readonly status: number;

  constructor(status: number, error: JsonRpcErrorObject) {
    super("jsonrpc_error", error.message);
    this.name = "JsonRpcRequestError";
    this.rpcCode = error.code;
    this.rpcData = error.data;
    this.status = status;
  }
}

export const isRateLimitPayload = (value: unknown): value is RateLimitErrorPayload => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.limit === "number" && typeof candidate.resetAt === "number";
};

export const getErrorMessage = (value: unknown, fallback: string): string => {
  if (typeof value !== "object" || value === null) {
    return fallback;
  }

  const error = (value as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) {
    return fallback;
  }

  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" && message.length > 0 ? message : fallback;
};
