import type { Address, Hex } from "viem";

import type { ChainName, PaymasterQuote, PermitContext } from "./types.js";

export class ServoError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "ServoError";
    this.code = code;
    this.data = data;
  }
}

export interface ServoClientConfig {
  rpcUrl: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export class ServoClient {
  private readonly rpcUrl: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private requestId = 0;

  constructor(config: ServoClientConfig) {
    this.rpcUrl = config.rpcUrl.replace(/\/+$/u, "");
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.headers = config.headers ?? {};
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async getPaymasterData(
    userOp: Record<string, unknown>,
    entryPoint: Address,
    chain?: ChainName | number | string,
    context?: { permit?: PermitContext },
  ): Promise<PaymasterQuote> {
    return this.rpc("pm_getPaymasterData", [userOp, entryPoint, chain, context ?? {}]);
  }

  async getPaymasterStubData(
    userOp: Record<string, unknown>,
    entryPoint: Address,
    chain?: ChainName | number | string,
  ): Promise<PaymasterQuote> {
    return this.rpc("pm_getPaymasterStubData", [userOp, entryPoint, chain, {}]);
  }

  async sendUserOperation(userOp: Record<string, unknown>, entryPoint: Address): Promise<Hex> {
    return this.rpc("eth_sendUserOperation", [userOp, entryPoint]);
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const id = ++this.requestId;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ServoError(
        error instanceof DOMException && error.name === "AbortError"
          ? `Request timeout after ${this.timeoutMs}ms`
          : "Request failed",
      );
    } finally {
      clearTimeout(timeout);
    }

    const body = (await response.json()) as Record<string, unknown>;

    const rpcError = body.error as { code?: number; message?: string; data?: unknown } | undefined;
    if (rpcError && typeof rpcError === "object") {
      throw new ServoError(
        typeof rpcError.message === "string" ? rpcError.message : "RPC error",
        typeof rpcError.code === "number" ? rpcError.code : undefined,
        rpcError.data,
      );
    }

    if (!response.ok) {
      throw new ServoError(`HTTP ${response.status}`, response.status, body);
    }

    return body.result as T;
  }
}
