import {
  AgentPaymasterSdkError,
  HttpRequestError,
  JsonRpcRequestError,
  RateLimitError,
  TransportError,
  getErrorMessage,
  isRateLimitPayload,
} from "./errors.js";
import type {
  ChainName,
  JsonRpcFailure,
  JsonRpcResponse,
  PaymasterRpcResult,
  QuoteRequest,
  QuoteResponse,
  RateLimitErrorPayload,
  TransportConfig,
  UserOperation,
  UserOperationGasEstimate,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isJsonRpcFailure = (value: unknown): value is JsonRpcFailure => {
  if (!isObject(value)) {
    return false;
  }

  if (value.jsonrpc !== "2.0" || !("error" in value)) {
    return false;
  }

  const error = value.error;
  return (
    isObject(error) &&
    typeof error.code === "number" &&
    typeof error.message === "string" &&
    (error.data === undefined || error.data !== undefined)
  );
};

const parseJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const readRateLimitFromHeaders = (headers: Headers): RateLimitErrorPayload | null => {
  const limit = Number.parseInt(headers.get("x-ratelimit-limit") ?? "", 10);
  const resetAt = Number.parseInt(headers.get("x-ratelimit-reset") ?? "", 10);

  if (Number.isFinite(limit) && Number.isFinite(resetAt)) {
    return { limit, resetAt };
  }

  return null;
};

const readRateLimitFromPayload = (payload: unknown): RateLimitErrorPayload | null => {
  if (!isObject(payload)) {
    return null;
  }

  if (isObject(payload.error)) {
    const rate = payload.error as Record<string, unknown>;

    if (isRateLimitPayload(rate)) {
      return rate;
    }

    if (isObject(rate.data) && isRateLimitPayload(rate.data)) {
      return rate.data;
    }
  }

  return null;
};

const withTimeout = async <T>(
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
};

const normalizeApiUrl = (apiUrl: string): string => apiUrl.replace(/\/+$/u, "");

interface JsonRequestResult {
  status: number;
  headers: Headers;
  body: unknown;
}

export class AgentPaymasterClient {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private requestId = 1;

  constructor(config: TransportConfig) {
    this.apiUrl = normalizeApiUrl(config.apiUrl);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.headers = config.headers ?? {};
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async ethEstimateUserOperationGas(
    userOperation: UserOperation,
    entryPoint: string,
  ): Promise<UserOperationGasEstimate> {
    return this.rpc<UserOperationGasEstimate>("eth_estimateUserOperationGas", [userOperation, entryPoint]);
  }

  async ethSendUserOperation(userOperation: UserOperation, entryPoint: string): Promise<string> {
    return this.rpc<string>("eth_sendUserOperation", [userOperation, entryPoint]);
  }

  async pmGetPaymasterData(
    userOperation: UserOperation,
    entryPoint: string,
    chain?: ChainName | number | `${number}`,
  ): Promise<PaymasterRpcResult> {
    return this.rpc<PaymasterRpcResult>("pm_getPaymasterData", [userOperation, entryPoint, chain]);
  }

  async pmGetPaymasterStubData(
    userOperation: UserOperation,
    entryPoint: string,
    chain?: ChainName | number | `${number}`,
  ): Promise<PaymasterRpcResult> {
    return this.rpc<PaymasterRpcResult>("pm_getPaymasterStubData", [userOperation, entryPoint, chain]);
  }

  async getUsdcQuote(request: QuoteRequest): Promise<QuoteResponse> {
    const response = await this.postJson("/v1/paymaster/quote", request);

    if (!isObject(response) || typeof response.quoteId !== "string") {
      throw new AgentPaymasterSdkError("invalid_response", "Quote endpoint returned an invalid payload");
    }

    return response as unknown as QuoteResponse;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await this.postJson("/rpc", {
      jsonrpc: "2.0",
      id: this.requestId,
      method,
      params,
    });
    this.requestId += 1;

    if (isJsonRpcFailure(response)) {
      throw new JsonRpcRequestError(200, response.error);
    }

    if (!isObject(response) || response.jsonrpc !== "2.0" || !("result" in response)) {
      throw new AgentPaymasterSdkError("invalid_response", "JSON-RPC endpoint returned an invalid payload");
    }

    return response.result as T;
  }

  private async postJson(path: string, payload: unknown): Promise<unknown> {
    const response = await this.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (response.status >= 200 && response.status < 300) {
      return response.body;
    }

    if (isJsonRpcFailure(response.body)) {
      throw new JsonRpcRequestError(response.status, response.body.error);
    }

    const rateLimit =
      readRateLimitFromPayload(response.body) ?? readRateLimitFromHeaders(response.headers);

    if (response.status === 429 && rateLimit !== null) {
      throw new RateLimitError(
        response.status,
        getErrorMessage(response.body, "Rate limit exceeded"),
        response.body,
        rateLimit,
      );
    }

    throw new HttpRequestError(
      response.status,
      getErrorMessage(response.body, `HTTP request failed with status ${response.status}`),
      response.body,
    );
  }

  private async request(path: string, init: RequestInit): Promise<JsonRequestResult> {
    let response: Response;

    try {
      response = await withTimeout(this.timeoutMs, (signal) =>
        this.fetchImpl(`${this.apiUrl}${path}`, {
          ...init,
          headers: {
            ...this.headers,
            ...(init.headers ?? {}),
          },
          signal,
        }),
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new TransportError(`Request timeout after ${this.timeoutMs}ms`, error);
      }

      throw new TransportError("Request failed", error);
    }

    return {
      status: response.status,
      headers: response.headers,
      body: await parseJson(response),
    };
  }
}

export const isJsonRpcResponse = (value: unknown): value is JsonRpcResponse => {
  if (!isObject(value) || value.jsonrpc !== "2.0") {
    return false;
  }

  if (!(typeof value.id === "string" || typeof value.id === "number" || value.id === null)) {
    return false;
  }

  return "result" in value || isJsonRpcFailure(value);
};
