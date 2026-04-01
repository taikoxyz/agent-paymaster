import { describe, expect, it } from "vitest";

import type { BundlerClient } from "./bundler-client.js";
import { EntryPointMonitor } from "./entrypoint-monitor.js";
import { createApp, validateConfig } from "./index.js";
import { StaticPriceProvider } from "./paymaster-service.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

const ENTRY_POINT_V07 = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const TEST_QUOTE_SIGNER_PRIVATE_KEY = `0x${"2".repeat(64)}` as const;
const TEST_PAYMASTER_ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_TOKEN_ADDRESS = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TEST_FACTORY_ADDRESS = "0xcccccccccccccccccccccccccccccccccccccccc";

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
        result: [ENTRY_POINT_V07],
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
      details: {
        service: "bundler",
        pendingUserOperations: 1,
        submittingUserOperations: 0,
        mempoolDepth: {
          pending: 1,
          submitting: 0,
          total: 1,
        },
        mempoolAgeMs: {
          pendingOldest: 2300,
          submittingOldest: 0,
        },
        mempoolAgeDistribution: {
          pending: {
            le_30000ms: 1,
            le_60000ms: 0,
            le_300000ms: 0,
            le_900000ms: 0,
            gt_900000ms: 0,
          },
          submitting: {
            le_30000ms: 0,
            le_60000ms: 0,
            le_300000ms: 0,
            le_900000ms: 0,
            gt_900000ms: 0,
          },
        },
        submitter: {
          lastKnownBalanceWei: "123000000000000000",
        },
        operationalMetrics: {
          userOpsAcceptedTotal: 2,
          userOpsIncludedTotal: 1,
          userOpsFailedTotal: 1,
          acceptanceToInclusionSuccessRate: 0.5,
          averageAcceptanceToInclusionMs: 1800,
          simulationFailureReasons: {
            simulation_failed: 1,
          },
          revertReasons: {
            AA23_reverted: 1,
          },
        },
      },
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

class RejectAmbiguousInitCodeBundlerClient extends FakeBundlerClient {
  async rpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    this.rpcCalls.push(request);

    if (request.method === "eth_estimateUserOperationGas") {
      const [userOp] = request.params as [Record<string, unknown>, string];
      const hasInitCode = userOp.initCode !== undefined && userOp.initCode !== null;
      const hasFactory = userOp.factory !== undefined && userOp.factory !== null;

      if (hasInitCode && hasFactory) {
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32602,
            message: "Provide either initCode or factory/factoryData, not both",
          },
        };
      }

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
        result: [ENTRY_POINT_V07],
      };
    }

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: { ok: true },
    };
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
        accountFactoryAddress: TEST_FACTORY_ADDRESS,
        tokenAddresses: {
          taikoMainnet: TEST_TOKEN_ADDRESS,
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
    expect(payload.result).toEqual([ENTRY_POINT_V07]);
    expect(bundlerClient.rpcCalls).toHaveLength(1);
    expect(bundlerClient.rpcCalls[0]?.method).toBe("eth_supportedEntryPoints");
  });

  it("serves pm_supportedEntryPoints from paymaster service", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "pm_supportedEntryPoints",
        params: [],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.result).toEqual([ENTRY_POINT_V07]);
    expect(bundlerClient.rpcCalls).toHaveLength(0);
  });

  it("serves pm_getCapabilities from paymaster service", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "pm_getCapabilities",
        params: [],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.result.supportedEntryPoints).toEqual([ENTRY_POINT_V07]);
    expect(payload.result.accountFactoryAddress).toBe(TEST_FACTORY_ADDRESS);
    expect(payload.result.permit).toEqual({
      standard: "EIP-2612",
      requiredForSponsoredQuote: true,
      fields: ["value", "deadline", "signature"],
    });
    expect(bundlerClient.rpcCalls).toHaveLength(0);
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
        params: [SAMPLE_USER_OPERATION, ENTRY_POINT_V07, "taikoMainnet"],
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
    expect(payload.error.data?.supportedEntryPoints).toEqual([ENTRY_POINT_V07]);
    expect(bundlerClient.rpcCalls).toHaveLength(0);
  });

  it("rejects eth_sendUserOperation with unsupported entryPoint before forwarding", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "eth_sendUserOperation",
        params: [SAMPLE_USER_OPERATION, "0xDeaDDeaDDeaDDeaDDeaDDeaDDeaDDeaDDeaDDeaD"],
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.error.code).toBe(-32602);
    expect(payload.error.message).toBe("Unsupported entryPoint");
    expect(payload.error.data?.reason).toBe("entrypoint_unsupported");
    expect(payload.error.data?.supportedEntryPoints).toEqual([ENTRY_POINT_V07]);
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
    expect(body).toContain('api_bundler_mempool_depth{state="pending"} 1');
    expect(body).toContain("api_userop_acceptance_to_inclusion_success_ratio 0.5");
    expect(body).toContain("api_quote_to_submission_conversion_ratio 0");
    expect(body).toContain('api_userop_simulation_failures_total{reason="simulation_failed"} 1');
    expect(body).toContain('api_userop_revert_reasons_total{reason="AA23_reverted"} 1');
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

  it("serves REST capabilities endpoint", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/capabilities");
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.supportedEntryPoints).toEqual([ENTRY_POINT_V07]);
    expect(payload.supportedTokens).toEqual([
      {
        symbol: "USDC",
        addresses: {
          taikoMainnet: TEST_TOKEN_ADDRESS,
          taikoHoodi: TEST_TOKEN_ADDRESS,
        },
      },
    ]);
    expect(payload.accountFactoryAddress).toBe(TEST_FACTORY_ADDRESS);
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
          ENTRY_POINT_V07,
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
          ENTRY_POINT_V07,
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
    expect(payload.error.code).toBe(-32602);
    expect(payload.error.message).toContain("Permit value");
  });

  it("pm_getPaymasterData rejects malformed permit context with structured error", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11.5,
        method: "pm_getPaymasterData",
        params: [SAMPLE_USER_OPERATION, ENTRY_POINT_V07, "taikoMainnet", { permit: "0xdeadbeef" }],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.error).toBeDefined();
    expect(payload.error.code).toBe(-32602);
    expect(payload.error.message).toBe("Invalid permit context");
    expect(payload.error.data?.reason).toBe("permit_invalid");
    expect(payload.error.data?.detail).toContain("context.permit must be an object");
    expect(bundlerClient.rpcCalls).toHaveLength(0);
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
          ENTRY_POINT_V07,
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

  it("pm_getPaymasterStubData succeeds with minimal UserOp (no initCode/signature)", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const minimalUserOp = {
      sender: "0x1111111111111111111111111111111111111111",
      nonce: "0x1",
      callData: "0x1234",
      maxFeePerGas: "0x100",
      maxPriorityFeePerGas: "0x10",
    };

    const response = await app.request("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 20,
        method: "pm_getPaymasterStubData",
        params: [minimalUserOp, ENTRY_POINT_V07, "taikoMainnet", {}],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.result.isStub).toBe(true);
    expect(payload.result.paymasterData).toBeDefined();

    // Verify the bundler received defaults for missing fields
    const estimateCall = bundlerClient.rpcCalls.find(
      (call) => call.method === "eth_estimateUserOperationGas",
    );
    expect(estimateCall).toBeDefined();
    const sentUserOp = (estimateCall!.params as unknown[])[0] as Record<string, unknown>;
    expect(sentUserOp.initCode).toBe("0x");
    expect(sentUserOp.signature).toBeDefined();
    expect(sentUserOp.signature).not.toBe("0x");
  });

  it("pm_getPaymasterStubData accepts v0.7 factory/factoryData deployment fields", async () => {
    const bundlerClient = new RejectAmbiguousInitCodeBundlerClient();
    const app = createTestApp(bundlerClient);
    const factoryData = "0xabcdef";
    const v07UserOp = {
      sender: SAMPLE_USER_OPERATION.sender,
      nonce: SAMPLE_USER_OPERATION.nonce,
      factory: TEST_FACTORY_ADDRESS,
      factoryData,
      callData: SAMPLE_USER_OPERATION.callData,
      maxFeePerGas: SAMPLE_USER_OPERATION.maxFeePerGas,
      maxPriorityFeePerGas: SAMPLE_USER_OPERATION.maxPriorityFeePerGas,
    };

    const response = await app.request("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 22,
        method: "pm_getPaymasterStubData",
        params: [v07UserOp, ENTRY_POINT_V07, "taikoMainnet", {}],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.result.isStub).toBe(true);

    const estimateCall = bundlerClient.rpcCalls.find(
      (call) => call.method === "eth_estimateUserOperationGas",
    );
    const sentUserOp = (estimateCall!.params as unknown[])[0] as Record<string, unknown>;
    expect(sentUserOp.initCode).toBe(`${TEST_FACTORY_ADDRESS}${factoryData.slice(2)}`);
    expect(sentUserOp.factory).toBeUndefined();
    expect(sentUserOp.factoryData).toBeUndefined();
    expect(sentUserOp.signature).toBeDefined();
    expect(sentUserOp.signature).not.toBe("0x");
  });

  it("pm_getPaymasterStubData rejects invalid v0.7 factory length before estimation", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 23,
        method: "pm_getPaymasterStubData",
        params: [
          {
            sender: SAMPLE_USER_OPERATION.sender,
            nonce: SAMPLE_USER_OPERATION.nonce,
            factory: "0x1234",
            factoryData: "0xabcdef",
            callData: SAMPLE_USER_OPERATION.callData,
            maxFeePerGas: SAMPLE_USER_OPERATION.maxFeePerGas,
            maxPriorityFeePerGas: SAMPLE_USER_OPERATION.maxPriorityFeePerGas,
          },
          ENTRY_POINT_V07,
          "taikoMainnet",
          {},
        ],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.error.code).toBe(-32602);
    expect(payload.error.message).toContain("userOperation.factory must be a 20-byte address");
    expect(bundlerClient.rpcCalls).toHaveLength(0);
  });

  it("pm_getPaymasterStubData preserves caller-provided initCode and signature", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 21,
        method: "pm_getPaymasterStubData",
        params: [SAMPLE_USER_OPERATION, ENTRY_POINT_V07, "taikoMainnet", {}],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.result.isStub).toBe(true);

    // Verify the bundler received the caller's original values
    const estimateCall = bundlerClient.rpcCalls.find(
      (call) => call.method === "eth_estimateUserOperationGas",
    );
    const sentUserOp = (estimateCall!.params as unknown[])[0] as Record<string, unknown>;
    expect(sentUserOp.initCode).toBe("0x");
    expect(sentUserOp.signature).toBe("0x99");
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
        params: [SAMPLE_USER_OPERATION, ENTRY_POINT_V07, "taikoMainnet"],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.result.paymasterVerificationGasLimit).toBe("0x249f0");
    expect(payload.result.paymasterPostOpGasLimit).toBe("0x13880");
  });

  it("resolves hex chain ID (0x28c58) in pm_getPaymasterData", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 20,
        method: "pm_getPaymasterData",
        params: [SAMPLE_USER_OPERATION, ENTRY_POINT_V07, "0x28c58"],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.result).toBeDefined();
    expect(payload.result.token).toBe("USDC");
    expect(payload.result.paymasterAndData).toMatch(/^0x/);
  });

  it("resolves hex chain ID for taikoHoodi (0x28c65)", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 21,
        method: "pm_getPaymasterData",
        params: [SAMPLE_USER_OPERATION, ENTRY_POINT_V07, "0x28c65"],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.result).toBeDefined();
    expect(payload.result.token).toBe("USDC");
  });

  it("returns validation errors with code -32602 and useful message", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    // Invalid sender address
    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 30,
        method: "pm_getPaymasterData",
        params: [
          { ...SAMPLE_USER_OPERATION, sender: "not-an-address" },
          ENTRY_POINT_V07,
          "taikoMainnet",
        ],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.error).toBeDefined();
    expect(payload.error.code).toBe(-32602);
    expect(payload.error.message).toContain("must be a valid");
  });

  it("returns -32602 for missing required fields instead of -32603", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    // Missing userOperation entirely
    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 31,
        method: "pm_getPaymasterData",
        params: ["not-an-object", ENTRY_POINT_V07, "taikoMainnet"],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.error).toBeDefined();
    expect(payload.error.code).toBe(-32602);
    expect(payload.error.message).toContain("is required");
  });

  it("returns -32602 for hex quantity validation errors", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 32,
        method: "pm_getPaymasterData",
        params: [{ ...SAMPLE_USER_OPERATION, nonce: "not-hex" }, ENTRY_POINT_V07, "taikoMainnet"],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.error).toBeDefined();
    expect(payload.error.code).toBe(-32602);
    expect(payload.error.message).toContain("must be a hex quantity");
  });

  it("returns eth_chainId as hex string", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    const response = await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 40,
        method: "eth_chainId",
        params: [],
      }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.result).toBe("0x28c58");
    expect(bundlerClient.rpcCalls).toHaveLength(0);
  });

  it("eth_chainId is not forwarded to bundler", async () => {
    const bundlerClient = new FakeBundlerClient();
    const app = createTestApp(bundlerClient);

    await app.request("/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 41,
        method: "eth_chainId",
        params: [],
      }),
    });

    expect(bundlerClient.rpcCalls).toHaveLength(0);
  });
});
