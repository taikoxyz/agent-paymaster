import {
  HttpRequestError,
  RateLimitError,
  ServoError,
  TransportError,
  getErrorMessage,
  isRateLimitPayload,
} from "./errors.js";
import type {
  Address,
  ChainName,
  QuoteResponse,
  RateLimitErrorPayload,
  ServoClientConfig,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isHexString = (value: unknown): value is string =>
  typeof value === "string" && HEX_PATTERN.test(value);

const isAddress = (value: unknown): value is string =>
  typeof value === "string" && ADDRESS_PATTERN.test(value);

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

const isQuoteResponse = (value: unknown): value is QuoteResponse => {
  if (!isObject(value)) {
    return false;
  }

  const supportedTokens = value.supportedTokens;
  const supportedTokensValid =
    Array.isArray(supportedTokens) && supportedTokens.every((token) => token === "USDC");

  return (
    typeof value.quoteId === "string" &&
    (value.chain === "taikoMainnet" ||
      value.chain === "taikoHekla" ||
      value.chain === "taikoHoodi") &&
    typeof value.chainId === "number" &&
    Number.isInteger(value.chainId) &&
    value.token === "USDC" &&
    isAddress(value.paymaster) &&
    isHexString(value.paymasterData) &&
    isHexString(value.paymasterAndData) &&
    isHexString(value.callGasLimit) &&
    isHexString(value.verificationGasLimit) &&
    isHexString(value.preVerificationGas) &&
    isHexString(value.paymasterVerificationGasLimit) &&
    isHexString(value.paymasterPostOpGasLimit) &&
    isHexString(value.estimatedGasLimit) &&
    isHexString(value.estimatedGasWei) &&
    typeof value.maxTokenCostMicros === "string" &&
    typeof value.maxTokenCost === "string" &&
    typeof value.validUntil === "number" &&
    Number.isInteger(value.validUntil) &&
    isAddress(value.entryPoint) &&
    isAddress(value.sender) &&
    isAddress(value.tokenAddress) &&
    supportedTokensValid
  );
};

interface QuoteApiRequest {
  sender?: Address;
  chain?: ChainName | number | `${number}`;
  chainId?: number;
  entryPoint: Address;
  token?: "USDC";
  userOperation: Record<string, unknown>;
}

export class ServoClient {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ServoClientConfig) {
    this.apiUrl = normalizeApiUrl(config.apiUrl);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.headers = config.headers ?? {};
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async getUsdcQuote(request: QuoteApiRequest): Promise<QuoteResponse> {
    const response = await this.postJson("/v1/paymaster/quote", request);

    if (!isQuoteResponse(response.body)) {
      throw new ServoError(
        "invalid_response",
        "Quote endpoint returned an invalid payload",
      );
    }

    return response.body;
  }

  private async postJson(
    path: string,
    payload: unknown,
  ): Promise<{ status: number; headers: Headers; body: unknown }> {
    let response: Response;

    try {
      response = await withTimeout(this.timeoutMs, (signal) =>
        this.fetchImpl(`${this.apiUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.headers,
          },
          body: JSON.stringify(payload),
          signal,
        }),
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new TransportError(`Request timeout after ${this.timeoutMs}ms`, error);
      }

      throw new TransportError("Request failed", error);
    }

    const body = await parseJson(response);

    if (response.status >= 200 && response.status < 300) {
      return { status: response.status, headers: response.headers, body };
    }

    const rateLimit =
      readRateLimitFromPayload(body) ?? readRateLimitFromHeaders(response.headers);

    if (response.status === 429 && rateLimit !== null) {
      throw new RateLimitError(
        response.status,
        getErrorMessage(body, "Rate limit exceeded"),
        body,
        rateLimit,
      );
    }

    throw new HttpRequestError(
      response.status,
      getErrorMessage(body, `HTTP request failed with status ${response.status}`),
      body,
    );
  }
}
