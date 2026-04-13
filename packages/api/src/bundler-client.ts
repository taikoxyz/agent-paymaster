import { type JsonRpcRequest, type JsonRpcResponse, isObject } from "@agent-paymaster/shared";

export interface DependencyHealth {
  status: "ok" | "degraded";
  latencyMs: number;
  details?: unknown;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 2_500;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 150;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_RECOVERY_MS = 10_000;

const now = (): number => performance.now();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

const isRetryableError = (error: unknown): boolean => {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("abort") ||
      message.includes("timeout") ||
      message.includes("econnrefused") ||
      message.includes("econnreset") ||
      message.includes("fetch failed") ||
      message.includes("network")
    );
  }
  return false;
};

const isRetryableHttpStatus = (status: number): boolean => status >= 500;

const isJsonRpcResponse = (value: unknown): value is JsonRpcResponse => {
  if (!isObject(value) || value.jsonrpc !== "2.0") {
    return false;
  }

  if (!(typeof value.id === "string" || typeof value.id === "number" || value.id === null)) {
    return false;
  }

  return "result" in value || "error" in value;
};

export interface BundlerClient {
  rpc(request: JsonRpcRequest): Promise<JsonRpcResponse>;
  health(): Promise<DependencyHealth>;
}

interface HttpBundlerClientConfig {
  rpcUrl: string;
  healthUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpBundlerClient implements BundlerClient {
  private readonly rpcUrl: string;
  private readonly healthUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(config: HttpBundlerClientConfig) {
    this.rpcUrl = config.rpcUrl;
    this.healthUrl = config.healthUrl;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async rpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (Date.now() < this.circuitOpenUntil) {
      throw new Error("Bundler circuit breaker is open — requests temporarily blocked");
    }

    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const response = await withTimeout(this.timeoutMs, async (signal) =>
          this.fetchImpl(this.rpcUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(request),
            signal,
          }),
        );

        if (isRetryableHttpStatus(response.status) && attempt < MAX_RETRY_ATTEMPTS - 1) {
          lastError = new Error(`Bundler returned HTTP ${response.status}`);
          await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }

        const body = (await response.json().catch(() => null)) as unknown;

        if (!isJsonRpcResponse(body)) {
          throw new Error("Bundler returned an invalid JSON-RPC payload");
        }

        this.consecutiveFailures = 0;
        return body;
      } catch (error) {
        lastError = error;

        if (attempt < MAX_RETRY_ATTEMPTS - 1 && isRetryableError(error)) {
          await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }

        break;
      }
    }

    this.consecutiveFailures++;
    if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + CIRCUIT_RECOVERY_MS;
    }

    throw lastError;
  }

  async health(): Promise<DependencyHealth> {
    const startedAt = now();

    try {
      const response = await withTimeout(this.timeoutMs, async (signal) =>
        this.fetchImpl(this.healthUrl, {
          method: "GET",
          signal,
        }),
      );

      if (!response.ok) {
        return {
          status: "degraded",
          latencyMs: Math.round(now() - startedAt),
          error: `HTTP ${response.status}`,
        };
      }

      const details = (await response.json().catch(() => null)) as unknown;

      return {
        status: "ok",
        latencyMs: Math.round(now() - startedAt),
        details,
      };
    } catch (error) {
      return {
        status: "degraded",
        latencyMs: Math.round(now() - startedAt),
        error: error instanceof Error ? error.message : "bundler_unreachable",
      };
    }
  }
}
