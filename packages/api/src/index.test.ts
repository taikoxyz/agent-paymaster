import { describe, expect, it } from "vitest";

import type { BundlerClient } from "./bundler-client.js";
import { createApp } from "./index.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

const ENTRY_POINT_V08 = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const TEST_QUOTE_SIGNER_PRIVATE_KEY = `0x${"2".repeat(64)}` as const;

const SAMPLE_USER_OPERATION = {
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "0x1",
  initCode: "0x",
  callData: "0x1234",
  maxFeePerGas: "0x100",
  maxPriorityFeePerGas: "0x10",
  signature: "0x99",
};

class FakeBundlerClient implements BundlerClient {
  readonly rpcCalls: JsonRpcRequest[] = [];
  healthChecks = 0;

  async rpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    this.rpcCalls.push(request);

    if (request.method === "eth_estimateUserOperationGas") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          callGasLimit: "0x88d8",
          verificationGasLimit: "0x1d4c8",
          preVerificationGas: "0x5274",
          paymasterVerificationGasLimit: "0xea60",
          paymasterPostOpGasLimit: "0xafc8",
        },
      };
    }

    if (request.method === "eth_supportedEntryPoints") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: [ENTRY_POINT_V08],
      };
    }

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: { ok: true },
    };
  }

  async health() {
    this.healthChecks += 1;

    return {
      status: "ok" as const,
      latencyMs: 2,
      details: { service: "bundler" },
    };
  }
}

class MissingPaymasterGasBundlerClient extends FakeBundlerClient {
  async rpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    this.rpcCalls.push(request);

    if (request.method === "eth_estimateUserOperationGas") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          callGasLimit: "0x88d8",
          verificationGasLimit: "0x1d4c8",
          preVerificationGas: "0x5274",
        },
      };
    }

    return super.rpc(request);
  }
}

const createTestApp = (
  bundlerClient: BundlerClient,
  options: {
    rateLimiter?: FixedWindowRateLimiter;
  } = {},
) =>
  createApp({
    bundlerClient,
    rateLimiter: options.rateLimiter,
    config: {
      paymaster: {
        usdcPerEthMicros: 3_000_000_000n,
        quoteSignerPrivateKey: TEST_QUOTE_SIGNER_PRIVATE_KEY,
      },
    },
  });

describe("api gateway", () => {
  it("returns aggregated health", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/health");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.service).toBe("api");
    expect(payload.status).toBe("ok");
    expect(payload.dependencies.bundler.status).toBe("ok");
    expect(bundlerClient.healthChecks).toBe(1);
  });

  it("proxies eth_* methods to bundler via /rpc", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_supportedEntryPoints",
        params: [],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.result).toEqual([ENTRY_POINT_V08]);
    expect(bundlerClient.rpcCalls).toHaveLength(1);
    expect(bundlerClient.rpcCalls[0]?.method).toBe("eth_supportedEntryPoints");
  });

  it("serves pm_* methods from paymaster service via /rpc", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "pm_getPaymasterData",
        params: [SAMPLE_USER_OPERATION, ENTRY_POINT_V08, "taikoMainnet"],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.result.paymaster).toMatch(/^0x[a-f0-9]{40}$/);
    expect(payload.result.token).toBe("USDC");
    expect(payload.result.maxTokenCost).toMatch(/^\d+\.\d{6}$/);

    const estimateCall = bundlerClient.rpcCalls.find(
      (call) => call.method === "eth_estimateUserOperationGas",
    );
    expect(estimateCall).toBeDefined();
  });

  it("returns a USDC quote payload", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/v1/paymaster/quote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chain: "taikoMainnet",
        entryPoint: ENTRY_POINT_V08,
        token: "USDC",
        userOperation: SAMPLE_USER_OPERATION,
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.chain).toBe("taikoMainnet");
    expect(payload.supportedTokens).toContain("USDC");
    expect(payload.paymasterAndData.startsWith("0x")).toBe(true);
    expect(payload.paymasterData.startsWith("0x")).toBe(true);
    expect(Buffer.from(payload.paymasterData.slice(2), "hex").toString("utf8")).not.toContain(
      "quoteId",
    );
    expect(payload.maxTokenCostMicros).toMatch(/^\d+$/);
  });

  it("applies sender-based rate limits", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient, {
      rateLimiter: new FixedWindowRateLimiter({
        maxRequestsPerWindow: 1,
        windowMs: 120_000,
      }),
    });

    const first = await app.request("/v1/paymaster/quote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chain: "taikoMainnet",
        entryPoint: ENTRY_POINT_V08,
        token: "USDC",
        userOperation: SAMPLE_USER_OPERATION,
      }),
    });

    expect(first.status).toBe(200);

    const second = await app.request("/v1/paymaster/quote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chain: "taikoMainnet",
        entryPoint: ENTRY_POINT_V08,
        token: "USDC",
        userOperation: SAMPLE_USER_OPERATION,
      }),
    });

    expect(second.status).toBe(429);

    const payload = await second.json();
    expect(payload.error.code).toBe("rate_limit_exceeded");
  });

  it("exports metrics in Prometheus format", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    await app.request("/health");
    await app.request("/status");

    const response = await app.request("/metrics");
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain("api_http_requests_total");
    expect(body).toContain("api_http_request_duration_ms_count");
  });

  it("serves OpenAPI description", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/openapi.json");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.openapi).toBe("3.1.0");
    expect(payload.paths["/rpc"]).toBeDefined();
  });

  it("returns HTTP 200 for JSON-RPC errors", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient, {
      rateLimiter: new FixedWindowRateLimiter({
        maxRequestsPerWindow: 1,
        windowMs: 120_000,
      }),
    });

    const parseError = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{",
    });
    expect(parseError.status).toBe(200);

    const invalidRequest = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ foo: "bar" }),
    });
    expect(invalidRequest.status).toBe(200);

    const first = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "1.2.3.4",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_supportedEntryPoints",
        params: [{ sender: "0xnotanaddress" }],
      }),
    });
    expect(first.status).toBe(200);

    const second = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "1.2.3.4",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "eth_supportedEntryPoints",
        params: [{ sender: "0xstillnotanaddress" }],
      }),
    });
    expect(second.status).toBe(200);
    const payload = await second.json();
    expect(payload.error.code).toBe(-32005);
  });

  it("falls back to configured paymaster gas limits when bundler omits them", async () => {
    const bundlerClient = new MissingPaymasterGasBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/v1/paymaster/quote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chain: "taikoMainnet",
        entryPoint: ENTRY_POINT_V08,
        token: "USDC",
        userOperation: SAMPLE_USER_OPERATION,
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.paymasterVerificationGasLimit).toBe("0xea60");
    expect(payload.paymasterPostOpGasLimit).toBe("0xafc8");
  });

  it("does not expose pricing internals from /status", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/status");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.paymaster.usdcPerEth).toBeUndefined();
    expect(payload.paymaster.tokenAddresses).toBeUndefined();
    expect(payload.paymaster.surchargeBps).toBeUndefined();
  });
});
