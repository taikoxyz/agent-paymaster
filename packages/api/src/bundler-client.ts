import {
  type DependencyHealth,
  type JsonRpcRequest,
  type JsonRpcResponse,
  isObject,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 2_500;

const now = (): number => performance.now();

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

export interface HttpBundlerClientConfig {
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

  constructor(config: HttpBundlerClientConfig) {
    this.rpcUrl = config.rpcUrl;
    this.healthUrl = config.healthUrl;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async rpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
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

    const body = (await response.json().catch(() => null)) as unknown;

    if (!isJsonRpcResponse(body)) {
      throw new Error("Bundler returned an invalid JSON-RPC payload");
    }

    return body;
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
