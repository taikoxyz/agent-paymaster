import { describe, expect, it } from "vitest";

import type { BundlerClient } from "./bundler-client.js";
import { EntryPointMonitor } from "./entrypoint-monitor.js";
import { createApp, validateConfig } from "./index.js";
import { StaticPriceProvider } from "./paymaster-service.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

const ENTRY_POINT_V08 = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const TEST_QUOTE_SIGNER_PRIVATE_KEY = `0x${"2".repeat(64)}` as const;
const TEST_PAYMASTER_ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_TOKEN_ADDRESS = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
          callGasLimit: "0xd6f8",
          verificationGasLimit: "0x1d4c8",
          preVerificationGas: "0x5274",
          paymasterVerificationGasLimit: "0x1d4c0",
          paymasterPostOpGasLimit: "0x13880",
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
    entryPointMonitor: null,
    config: {
      paymaster: {
        priceProvider: new StaticPriceProvider(3_000_000_000n),
        quoteSignerPrivateKey: TEST_QUOTE_SIGNER_PRIVATE_KEY,
        paymasterAddress: TEST_PAYMASTER_ADDRESS,
        tokenAddresses: {
          taikoMainnet: TEST_TOKEN_ADDRESS,
          taikoHekla: TEST_TOKEN_ADDRESS,
          taikoHoodi: TEST_TOKEN_ADDRESS,
        },
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

  it("rejects unsupported paymaster entryPoint before bundler estimation", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "pm_getPaymasterData",
        params: [
          SAMPLE_USER_OPERATION,
          "0xDeaDDeaDDeaDDeaDDeaDDeaDDeaDDeaDDeaDDeaD",
          "taikoMainnet",
        ],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.error.code).toBe(-32602);
    expect(payload.error.message).toBe("Unsupported entryPoint");
    expect(payload.error.data?.reason).toBe("entrypoint_unsupported");
    expect(payload.error.data?.supportedEntryPoints).toEqual([ENTRY_POINT_V08]);
    expect(bundlerClient.rpcCalls).toHaveLength(0);
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

  it("accepts config with a single valid chain token address", () => {
    expect(() =>
      validateConfig({
        PAYMASTER_QUOTE_SIGNER_PRIVATE_KEY: TEST_QUOTE_SIGNER_PRIVATE_KEY,
        PAYMASTER_ADDRESS: TEST_PAYMASTER_ADDRESS,
        USDC_MAINNET_ADDRESS: TEST_TOKEN_ADDRESS,
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("accepts oracle mode when an Ethereum mainnet RPC is configured", () => {
    expect(() =>
      validateConfig({
        PAYMASTER_QUOTE_SIGNER_PRIVATE_KEY: TEST_QUOTE_SIGNER_PRIVATE_KEY,
        PAYMASTER_ADDRESS: TEST_PAYMASTER_ADDRESS,
        ETHEREUM_MAINNET_RPC_URL: "https://ethereum-rpc.example",
        USDC_MAINNET_ADDRESS: TEST_TOKEN_ADDRESS,
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("rejects config with no chain token addresses", () => {
    expect(() =>
      validateConfig({
        PAYMASTER_QUOTE_SIGNER_PRIVATE_KEY: TEST_QUOTE_SIGNER_PRIVATE_KEY,
        PAYMASTER_ADDRESS: TEST_PAYMASTER_ADDRESS,
      } as NodeJS.ProcessEnv),
    ).toThrow("At least one USDC_*_ADDRESS must be configured");
  });

  it("rejects deprecated static pricing configuration", () => {
    expect(() =>
      validateConfig({
        PAYMASTER_QUOTE_SIGNER_PRIVATE_KEY: TEST_QUOTE_SIGNER_PRIVATE_KEY,
        PAYMASTER_ADDRESS: TEST_PAYMASTER_ADDRESS,
        PAYMASTER_STATIC_USDC_PER_ETH_MICROS: "3000000000",
        USDC_MAINNET_ADDRESS: TEST_TOKEN_ADDRESS,
      } as NodeJS.ProcessEnv),
    ).toThrow("PAYMASTER_STATIC_USDC_PER_ETH_MICROS is no longer supported");
  });

  it("pm_getPaymasterData with permit context embeds permit", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "pm_getPaymasterData",
        params: [
          SAMPLE_USER_OPERATION,
          ENTRY_POINT_V08,
          "taikoMainnet",
          {
            permit: {
              value: "999999999",
              deadline: "1900000000",
              signature: "0xaabbccdd",
            },
          },
        ],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.result.paymasterData).toContain("aabbccdd");
  });

  it("pm_getPaymasterData rejects permit below maxTokenCost", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "pm_getPaymasterData",
        params: [
          SAMPLE_USER_OPERATION,
          ENTRY_POINT_V08,
          "taikoMainnet",
          {
            permit: {
              value: "0",
              deadline: "1900000000",
              signature: "0xaabbccdd",
            },
          },
        ],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.error).toBeDefined();
    expect(payload.error.code).toBe(-32603);
  });

  it("pm_getPaymasterStubData ignores permit context", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "pm_getPaymasterStubData",
        params: [
          SAMPLE_USER_OPERATION,
          ENTRY_POINT_V08,
          "taikoMainnet",
          {
            permit: {
              value: "999999999",
              deadline: "1900000000",
              signature: "0xaabbccdd",
            },
          },
        ],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.result.isStub).toBe(true);
    expect(payload.result.paymasterData).toBeDefined();
  });

  it("health includes entrypoint deposit when monitor is provided", async () => {
    const bundlerClient = new FakeBundlerClient();
    const balanceHex = "0x" + 10_000_000_000_000_000n.toString(16).padStart(64, "0");
    const monitor = new EntryPointMonitor({
      paymasterAddress: TEST_PAYMASTER_ADDRESS,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: "ep-deposit", result: balanceHex }), {
          status: 200,
        })) as unknown as typeof fetch,
    });

    const app = createApp({
      bundlerClient,
      entryPointMonitor: monitor,
      config: {
        paymaster: {
          priceProvider: new StaticPriceProvider(3_000_000_000n),
          quoteSignerPrivateKey: TEST_QUOTE_SIGNER_PRIVATE_KEY,
          paymasterAddress: TEST_PAYMASTER_ADDRESS,
          tokenAddresses: { taikoMainnet: TEST_TOKEN_ADDRESS },
        },
      },
    });

    const response = await app.request("/health");
    const payload = await response.json();
    expect(payload.status).toBe("ok");
    expect(payload.dependencies.entryPointDeposit.status).toBe("ok");
    expect(payload.dependencies.entryPointDeposit.balanceWei).toBe("10000000000000000");
  });

  it("health degrades when entrypoint deposit is critical", async () => {
    const bundlerClient = new FakeBundlerClient();
    const balanceHex = "0x" + 100_000_000_000_000n.toString(16).padStart(64, "0");
    const monitor = new EntryPointMonitor({
      paymasterAddress: TEST_PAYMASTER_ADDRESS,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: "ep-deposit", result: balanceHex }), {
          status: 200,
        })) as unknown as typeof fetch,
    });

    const app = createApp({
      bundlerClient,
      entryPointMonitor: monitor,
      config: {
        paymaster: {
          priceProvider: new StaticPriceProvider(3_000_000_000n),
          quoteSignerPrivateKey: TEST_QUOTE_SIGNER_PRIVATE_KEY,
          paymasterAddress: TEST_PAYMASTER_ADDRESS,
          tokenAddresses: { taikoMainnet: TEST_TOKEN_ADDRESS },
        },
      },
    });

    const response = await app.request("/health");
    const payload = await response.json();
    expect(payload.status).toBe("degraded");
    expect(payload.dependencies.entryPointDeposit.status).toBe("critical");
  });

  it("health stays ok when entrypoint deposit is low but not critical", async () => {
    const bundlerClient = new FakeBundlerClient();
    const balanceHex = "0x" + 1_000_000_000_000_000n.toString(16).padStart(64, "0");
    const monitor = new EntryPointMonitor({
      paymasterAddress: TEST_PAYMASTER_ADDRESS,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: "ep-deposit", result: balanceHex }), {
          status: 200,
        })) as unknown as typeof fetch,
    });

    const app = createApp({
      bundlerClient,
      entryPointMonitor: monitor,
      config: {
        paymaster: {
          priceProvider: new StaticPriceProvider(3_000_000_000n),
          quoteSignerPrivateKey: TEST_QUOTE_SIGNER_PRIVATE_KEY,
          paymasterAddress: TEST_PAYMASTER_ADDRESS,
          tokenAddresses: { taikoMainnet: TEST_TOKEN_ADDRESS },
        },
      },
    });

    const response = await app.request("/health");
    const payload = await response.json();
    expect(payload.status).toBe("ok");
    expect(payload.dependencies.entryPointDeposit.status).toBe("low");
  });

  it("falls back to configured paymaster gas limits via pm_getPaymasterData", async () => {
    const bundlerClient = new MissingPaymasterGasBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 13,
        method: "pm_getPaymasterData",
        params: [SAMPLE_USER_OPERATION, ENTRY_POINT_V08, "taikoMainnet"],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.result.paymasterVerificationGasLimit).toBe("0x249f0");
    expect(payload.result.paymasterPostOpGasLimit).toBe("0x13880");
  });
});
