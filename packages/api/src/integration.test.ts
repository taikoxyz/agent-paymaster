/**
 * Integration tests for the agent-paymaster system.
 *
 * Wires up real BundlerService → API gateway → SDK client
 * to test the full UserOp lifecycle end-to-end without HTTP servers.
 */
import { describe, expect, it, beforeEach } from "vitest";

import { BundlerService } from "@agent-paymaster/bundler";
import { AgentPaymasterClient, type UserOperation } from "@agent-paymaster/sdk";

import type { BundlerClient } from "./bundler-client.js";
import { createApp } from "./index.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import type { JsonRpcRequest, JsonRpcResponse, DependencyHealth } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENTRY_POINT_V08 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const ENTRY_POINT_V08_LOWER = ENTRY_POINT_V08.toLowerCase();
const TEST_QUOTE_SIGNER_PRIVATE_KEY = `0x${"2".repeat(64)}` as const;
const USDC_PER_ETH_MICROS = 3_000_000_000n; // $3000 per ETH

const SENDER_A = "0x1111111111111111111111111111111111111111" as const;
const SENDER_B = "0x2222222222222222222222222222222222222222" as const;
const SENDER_C = "0x3333333333333333333333333333333333333333" as const;

// ---------------------------------------------------------------------------
// LocalBundlerClient: wraps BundlerService in the BundlerClient interface
// so the API gateway talks to the in-process bundler directly (no HTTP).
// ---------------------------------------------------------------------------

class LocalBundlerClient implements BundlerClient {
  constructor(readonly service: BundlerService) {}

  async rpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return this.service.handleJsonRpc(request);
  }

  async health(): Promise<DependencyHealth> {
    const h = this.service.getHealth();
    return {
      status: "ok" as const,
      latencyMs: 0,
      details: h,
    };
  }
}

// ---------------------------------------------------------------------------
// Test harness: creates the full stack and an SDK client that routes through it.
// ---------------------------------------------------------------------------

interface TestStack {
  bundlerService: BundlerService;
  bundlerClient: LocalBundlerClient;
  sdk: AgentPaymasterClient;
  /** Direct Hono app for low-level requests */
  app: ReturnType<typeof createApp>;
}

function createTestStack(options?: {
  rateLimiter?: FixedWindowRateLimiter;
  usdcPerEthMicros?: bigint;
  bundlerConfig?: ConstructorParameters<typeof BundlerService>[0];
}): TestStack {
  const bundlerService = new BundlerService({
    chainId: 167000,
    entryPoints: [ENTRY_POINT_V08],
    ...options?.bundlerConfig,
  });

  const bundlerClient = new LocalBundlerClient(bundlerService);

  const app = createApp({
    bundlerClient,
    rateLimiter: options?.rateLimiter,
    config: {
      paymaster: {
        usdcPerEthMicros: options?.usdcPerEthMicros ?? USDC_PER_ETH_MICROS,
        quoteSignerPrivateKey: TEST_QUOTE_SIGNER_PRIVATE_KEY,
      },
    },
  });

  // SDK client backed by Hono's in-process request handler
  const sdk = new AgentPaymasterClient({
    apiUrl: "http://localhost",
    timeoutMs: 5_000,
    fetchImpl: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      const path = url.pathname + url.search;
      return app.request(path, init as RequestInit);
    },
  });

  return { bundlerService, bundlerClient, sdk, app };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserOp(overrides: Partial<UserOperation> = {}): UserOperation {
  return {
    sender: SENDER_A,
    nonce: "0x1",
    initCode: "0x",
    callData: "0xabcdef",
    maxFeePerGas: "0x2540be400", // 10 gwei
    maxPriorityFeePerGas: "0x3b9aca00", // 1 gwei
    signature: "0xdeadbeef",
    ...overrides,
  };
}

// ============================================================================
// 1. Integration Test Suite — Full UserOp Lifecycle
// ============================================================================

describe("integration: full UserOp lifecycle", () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = createTestStack();
  });

  it("estimate gas → get paymaster data → send UserOp → bundle → receipt", async () => {
    const userOp = makeUserOp();

    // Step 1: Estimate gas via SDK → API → Bundler
    const gasEstimate = await stack.sdk.ethEstimateUserOperationGas(userOp, ENTRY_POINT_V08);

    expect(gasEstimate.callGasLimit).toMatch(/^0x[0-9a-f]+$/);
    expect(gasEstimate.verificationGasLimit).toMatch(/^0x[0-9a-f]+$/);
    expect(gasEstimate.preVerificationGas).toMatch(/^0x[0-9a-f]+$/);
    expect(gasEstimate.paymasterVerificationGasLimit).toMatch(/^0x[0-9a-f]+$/);
    expect(gasEstimate.paymasterPostOpGasLimit).toMatch(/^0x[0-9a-f]+$/);

    // Step 2: Get paymaster data (quote + signed paymasterAndData)
    const paymasterData = await stack.sdk.pmGetPaymasterData(
      userOp,
      ENTRY_POINT_V08,
      "taikoMainnet",
    );

    expect(paymasterData.paymaster).toMatch(/^0x[a-f0-9]{40}$/);
    expect(paymasterData.paymasterAndData).toMatch(/^0x/);
    expect(paymasterData.token).toBe("USDC");
    expect(paymasterData.maxTokenCost).toMatch(/^\d+\.\d{6}$/);
    expect(paymasterData.validUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // Step 3: Attach paymaster data and send the UserOp
    const fullUserOp: UserOperation = {
      ...userOp,
      callGasLimit: gasEstimate.callGasLimit,
      verificationGasLimit: gasEstimate.verificationGasLimit,
      preVerificationGas: gasEstimate.preVerificationGas,
      paymasterAndData: paymasterData.paymasterAndData,
    };

    const userOpHash = await stack.sdk.ethSendUserOperation(fullUserOp, ENTRY_POINT_V08);
    expect(userOpHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Step 4: Verify the UserOp is pending in the bundler
    expect(stack.bundlerService.getPendingUserOperationsCount()).toBe(1);

    // Step 5: Create a bundle
    const bundle = stack.bundlerService.createBundle();
    expect(bundle).not.toBeNull();
    expect(bundle!.userOperationHashes).toContain(userOpHash);

    // Step 6: Mark bundle as submitted on-chain
    stack.bundlerService.markBundleSubmitted(bundle!.bundleHash, {
      transactionHash: `0x${"aa".repeat(32)}`,
      blockNumber: 100,
      effectiveGasPrice: "0x2540be400",
      success: true,
    });

    // Step 7: Verify receipt is available
    const receipt = stack.bundlerService.getUserOperationReceipt(userOpHash);
    expect(receipt).not.toBeNull();
    expect(receipt!.success).toBe(true);
    expect(receipt!.sender).toBe(SENDER_A.toLowerCase());
    expect(receipt!.entryPoint).toBe(ENTRY_POINT_V08_LOWER);
    expect(BigInt(receipt!.actualGasUsed)).toBeGreaterThan(0n);
    expect(BigInt(receipt!.actualGasCost)).toBeGreaterThan(0n);

    // Step 8: Verify the operation can be looked up by hash
    const lookup = stack.bundlerService.getUserOperationByHash(userOpHash);
    expect(lookup).not.toBeNull();
    expect(lookup!.transactionHash).toBe(`0x${"aa".repeat(32)}`);
    expect(lookup!.blockNumber).toMatch(/^0x/);
  });

  it("duplicate send returns the same hash (idempotency)", async () => {
    const userOp = makeUserOp();

    const hash1 = await stack.sdk.ethSendUserOperation(userOp, ENTRY_POINT_V08);
    const hash2 = await stack.sdk.ethSendUserOperation(userOp, ENTRY_POINT_V08);

    expect(hash1).toBe(hash2);
    expect(stack.bundlerService.getPendingUserOperationsCount()).toBe(1);
  });

  it("REST quote endpoint returns a complete quote", async () => {
    const userOp = makeUserOp();

    const quote = await stack.sdk.getUsdcQuote({
      sender: SENDER_A,
      chain: "taikoMainnet",
      entryPoint: ENTRY_POINT_V08,
      token: "USDC",
      userOperation: userOp,
    });

    expect(quote.chain).toBe("taikoMainnet");
    expect(quote.chainId).toBe(167000);
    expect(quote.token).toBe("USDC");
    expect(quote.paymaster).toMatch(/^0x[a-f0-9]{40}$/);
    expect(quote.paymasterAndData).toMatch(/^0x/);
    expect(quote.paymasterData).toMatch(/^0x/);
    expect(quote.estimatedGasLimit).toMatch(/^0x[0-9a-f]+$/);
    expect(quote.estimatedGasWei).toMatch(/^0x[0-9a-f]+$/);
    expect(Number(quote.maxTokenCostMicros)).toBeGreaterThan(0);
    expect(quote.validUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(quote.sender).toBe(SENDER_A.toLowerCase());
    expect(quote.entryPoint).toBe(ENTRY_POINT_V08_LOWER);
    expect(quote.supportedTokens).toContain("USDC");
  });

  it("supports pm_getPaymasterStubData for gas estimation", async () => {
    const userOp = makeUserOp();

    const stub = await stack.sdk.pmGetPaymasterStubData(
      userOp,
      ENTRY_POINT_V08,
      "taikoMainnet",
    );

    expect(stub.isStub).toBe(true);
    expect(stub.paymasterAndData).toMatch(/^0x/);
    expect(stub.token).toBe("USDC");
  });

  it("health endpoint reports ok when bundler is healthy", async () => {
    const response = await stack.app.request("/health");
    const body = await response.json();

    expect(body.status).toBe("ok");
    expect(body.service).toBe("api");
    expect(body.dependencies.bundler.status).toBe("ok");
  });
});

// ============================================================================
// 2. Scenario Tests
// ============================================================================

describe("scenario: happy path with all Taiko chains", () => {
  it("generates valid quotes for taikoMainnet, taikoHekla, and taikoHoodi", async () => {
    const stack = createTestStack();
    const userOp = makeUserOp();

    for (const chain of ["taikoMainnet", "taikoHekla", "taikoHoodi"] as const) {
      const data = await stack.sdk.pmGetPaymasterData(userOp, ENTRY_POINT_V08, chain);
      expect(data.token).toBe("USDC");
      expect(data.paymasterAndData).toMatch(/^0x/);
      expect(data.maxTokenCost).toMatch(/^\d+\.\d{6}$/);
    }
  });
});

describe("scenario: invalid UserOp fields", () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = createTestStack();
  });

  it("rejects UserOp with invalid sender address", async () => {
    const userOp = makeUserOp({ sender: "0xnotanaddress" as `0x${string}` });

    await expect(
      stack.sdk.ethSendUserOperation(userOp, ENTRY_POINT_V08),
    ).rejects.toThrow();
  });

  it("rejects UserOp with missing required fields via RPC", async () => {
    const response = await stack.app.request("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendUserOperation",
        params: [{ sender: SENDER_A }, ENTRY_POINT_V08],
      }),
    });

    const payload = await response.json();
    expect(payload.error).toBeDefined();
    expect(payload.error.code).toBeLessThan(0);
  });

  it("rejects UserOp with non-hex callData", async () => {
    const response = await stack.app.request("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendUserOperation",
        params: [
          {
            sender: SENDER_A,
            nonce: "0x1",
            initCode: "0x",
            callData: "not-hex",
            maxFeePerGas: "0x100",
            maxPriorityFeePerGas: "0x10",
            signature: "0xaa",
          },
          ENTRY_POINT_V08,
        ],
      }),
    });

    const payload = await response.json();
    expect(payload.error).toBeDefined();
    expect(payload.error.data?.reason).toContain("hex");
  });

  it("rejects unsupported entry point", async () => {
    const userOp = makeUserOp();
    const badEntryPoint = "0xDeaDDeaDDeaDDeaDDeaDDeaDDeaDDeaDDeaDDeaD";

    await expect(
      stack.sdk.ethSendUserOperation(userOp, badEntryPoint),
    ).rejects.toThrow();
  });

  it("rejects non-JSON body on /rpc", async () => {
    const response = await stack.app.request("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{{{{",
    });

    const payload = await response.json();
    expect(payload.error.code).toBe(-32700); // Parse error
  });

  it("rejects invalid JSON-RPC request shape", async () => {
    const response = await stack.app.request("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ just: "data" }),
    });

    const payload = await response.json();
    expect(payload.error.code).toBe(-32600); // Invalid Request
  });

  it("returns method not found for unknown RPC method", async () => {
    const response = await stack.app.request("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_unknownMethod",
        params: [],
      }),
    });

    const payload = await response.json();
    expect(payload.error.code).toBe(-32601);
  });
});

describe("scenario: sender reputation and banning", () => {
  it("bans sender after repeated validation failures", async () => {
    const stack = createTestStack({
      bundlerConfig: {
        entryPoints: [ENTRY_POINT_V08],
        reputationMaxFailures: 3,
        banWindowMs: 60_000,
      },
    });

    // Send a valid UserOp then fail it repeatedly
    const userOps: string[] = [];
    for (let i = 0; i < 3; i++) {
      const userOp = makeUserOp({
        sender: SENDER_B,
        nonce: `0x${(i + 1).toString(16)}`,
      });
      const hash = await stack.sdk.ethSendUserOperation(userOp, ENTRY_POINT_V08);
      userOps.push(hash);
    }

    // Fail all three
    for (const hash of userOps) {
      stack.bundlerService.markUserOperationFailed(hash, "simulation_failed");
    }

    // Sender B should now be banned
    const bannedOp = makeUserOp({
      sender: SENDER_B,
      nonce: "0x10",
    });

    await expect(
      stack.sdk.ethSendUserOperation(bannedOp, ENTRY_POINT_V08),
    ).rejects.toThrow();
  });
});

describe("scenario: gas estimation with Taiko L1 data gas", () => {
  it("includes L1 data gas scalar in pre-verification gas", async () => {
    const stack = createTestStack({
      bundlerConfig: {
        entryPoints: [ENTRY_POINT_V08],
        l1DataGasScalar: 2n,
      },
    });

    const userOpWithL1 = makeUserOp({
      l1DataGas: "0x1000", // 4096
    });

    const estimate = await stack.sdk.ethEstimateUserOperationGas(userOpWithL1, ENTRY_POINT_V08);

    const userOpWithoutL1 = makeUserOp();
    const estimateNoL1 = await stack.sdk.ethEstimateUserOperationGas(userOpWithoutL1, ENTRY_POINT_V08);

    // With L1 data gas, preVerificationGas should be higher
    const preWithL1 = BigInt(estimate.preVerificationGas);
    const preWithoutL1 = BigInt(estimateNoL1.preVerificationGas);

    expect(preWithL1).toBeGreaterThan(preWithoutL1);
  });
});

describe("scenario: multiple UserOps in one bundle", () => {
  it("bundles multiple UserOps from different senders", async () => {
    const stack = createTestStack();

    const hashes: string[] = [];
    const senders = [SENDER_A, SENDER_B, SENDER_C];

    for (const sender of senders) {
      const userOp = makeUserOp({ sender, nonce: "0x1" });
      const hash = await stack.sdk.ethSendUserOperation(userOp, ENTRY_POINT_V08);
      hashes.push(hash);
    }

    expect(stack.bundlerService.getPendingUserOperationsCount()).toBe(3);

    // Create bundle with all three
    const bundle = stack.bundlerService.createBundle(10);
    expect(bundle).not.toBeNull();
    expect(bundle!.userOperationHashes).toHaveLength(3);

    for (const hash of hashes) {
      expect(bundle!.userOperationHashes).toContain(hash);
    }

    // Mark all as submitted
    stack.bundlerService.markBundleSubmitted(bundle!.bundleHash, {
      transactionHash: `0x${"bb".repeat(32)}`,
      blockNumber: 200,
      success: true,
    });

    // All should have receipts
    for (const hash of hashes) {
      const receipt = stack.bundlerService.getUserOperationReceipt(hash);
      expect(receipt).not.toBeNull();
      expect(receipt!.success).toBe(true);
    }
  });

  it("respects maxOperations limit when bundling", async () => {
    const stack = createTestStack();

    for (let i = 0; i < 5; i++) {
      const userOp = makeUserOp({
        sender: SENDER_A,
        nonce: `0x${(i + 1).toString(16)}`,
      });
      await stack.sdk.ethSendUserOperation(userOp, ENTRY_POINT_V08);
    }

    const bundle = stack.bundlerService.createBundle(2);
    expect(bundle).not.toBeNull();
    expect(bundle!.userOperationHashes).toHaveLength(2);

    // Remaining should still be pending
    expect(stack.bundlerService.getPendingUserOperationsCount()).toBe(5);
  });

  it("returns null when no pending operations for bundling", async () => {
    const stack = createTestStack();
    const bundle = stack.bundlerService.createBundle();
    expect(bundle).toBeNull();
  });
});

describe("scenario: failed bundle submission", () => {
  it("marks operations as failed when bundle submission fails", async () => {
    const stack = createTestStack();

    const userOp = makeUserOp();
    const hash = await stack.sdk.ethSendUserOperation(userOp, ENTRY_POINT_V08);

    const bundle = stack.bundlerService.createBundle();
    expect(bundle).not.toBeNull();

    stack.bundlerService.markBundleSubmitted(bundle!.bundleHash, {
      transactionHash: `0x${"cc".repeat(32)}`,
      blockNumber: 300,
      success: false,
      reason: "revert: EntryPoint: AA10 sender already constructed",
    });

    const receipt = stack.bundlerService.getUserOperationReceipt(hash);
    expect(receipt).not.toBeNull();
    expect(receipt!.success).toBe(false);
    expect(receipt!.receipt.status).toBe("0x0");
  });
});

describe("scenario: quote generation edge cases", () => {
  it("rejects quote for unsupported token", async () => {
    const stack = createTestStack();

    const response = await stack.app.request("/v1/paymaster/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: "taikoMainnet",
        entryPoint: ENTRY_POINT_V08,
        token: "DAI",
        userOperation: makeUserOp(),
      }),
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toBeDefined();
  });

  it("rejects quote with invalid JSON body", async () => {
    const localStack = createTestStack();
    const response = await localStack.app.request("/v1/paymaster/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("invalid_json");
  });

  it("rejects quote with unsupported chain", async () => {
    const stack = createTestStack();

    const response = await stack.app.request("/v1/paymaster/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: "ethereum",
        entryPoint: ENTRY_POINT_V08,
        token: "USDC",
        userOperation: makeUserOp(),
      }),
    });

    expect(response.status).toBe(400);
  });

  it("resolves chain by numeric ID", async () => {
    const stack = createTestStack();

    const data = await stack.sdk.pmGetPaymasterData(
      makeUserOp(),
      ENTRY_POINT_V08,
      167013, // taikoHoodi by ID
    );

    expect(data.token).toBe("USDC");
    expect(data.paymasterAndData).toMatch(/^0x/);
  });
});

describe("scenario: rate limiting across RPC and REST", () => {
  it("rate-limits /rpc by sender address", async () => {
    const stack = createTestStack({
      rateLimiter: new FixedWindowRateLimiter({
        maxRequestsPerWindow: 2,
        windowMs: 120_000,
      }),
    });

    const userOp = makeUserOp();

    // First two should succeed
    const r1 = await stack.sdk.ethEstimateUserOperationGas(userOp, ENTRY_POINT_V08);
    expect(r1.callGasLimit).toBeTruthy();

    const r2 = await stack.sdk.ethEstimateUserOperationGas(userOp, ENTRY_POINT_V08);
    expect(r2.callGasLimit).toBeTruthy();

    // Third should be rate limited (JSON-RPC error, not HTTP error)
    await expect(
      stack.sdk.ethEstimateUserOperationGas(userOp, ENTRY_POINT_V08),
    ).rejects.toThrow();
  });

  it("rate-limits /v1/paymaster/quote by sender and returns 429", async () => {
    const stack = createTestStack({
      rateLimiter: new FixedWindowRateLimiter({
        maxRequestsPerWindow: 1,
        windowMs: 120_000,
      }),
    });

    const quote1 = await stack.app.request("/v1/paymaster/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: "taikoMainnet",
        entryPoint: ENTRY_POINT_V08,
        token: "USDC",
        userOperation: makeUserOp(),
      }),
    });
    expect(quote1.status).toBe(200);

    const quote2 = await stack.app.request("/v1/paymaster/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: "taikoMainnet",
        entryPoint: ENTRY_POINT_V08,
        token: "USDC",
        userOperation: makeUserOp(),
      }),
    });
    expect(quote2.status).toBe(429);
    expect(quote2.headers.get("x-ratelimit-limit")).toBe("1");
  });

  it("different senders have independent rate limit buckets", async () => {
    const stack = createTestStack({
      rateLimiter: new FixedWindowRateLimiter({
        maxRequestsPerWindow: 1,
        windowMs: 120_000,
      }),
    });

    // Sender A uses their one request
    const r1 = await stack.sdk.ethSendUserOperation(
      makeUserOp({ sender: SENDER_A }),
      ENTRY_POINT_V08,
    );
    expect(r1).toMatch(/^0x/);

    // Sender B should still be able to send
    const r2 = await stack.sdk.ethSendUserOperation(
      makeUserOp({ sender: SENDER_B }),
      ENTRY_POINT_V08,
    );
    expect(r2).toMatch(/^0x/);
  });
});

// ============================================================================
// 3. Load Tests — basic throughput
// ============================================================================

describe("load: bundler throughput", () => {
  it("handles 100 concurrent UserOp submissions", async () => {
    const stack = createTestStack({
      rateLimiter: new FixedWindowRateLimiter({
        maxRequestsPerWindow: 10_000,
        windowMs: 60_000,
      }),
    });

    const submissions = Array.from({ length: 100 }, (_, i) =>
      stack.sdk.ethSendUserOperation(
        makeUserOp({
          sender: SENDER_A,
          nonce: `0x${(i + 1).toString(16)}`,
        }),
        ENTRY_POINT_V08,
      ),
    );

    const hashes = await Promise.all(submissions);
    const unique = new Set(hashes);

    expect(unique.size).toBe(100);
    expect(stack.bundlerService.getPendingUserOperationsCount()).toBe(100);
  });

  it("bundles and submits 50 operations in batches", async () => {
    const stack = createTestStack();
    const allHashes: string[] = [];

    // Submit 50 UserOps
    for (let i = 0; i < 50; i++) {
      const hash = await stack.sdk.ethSendUserOperation(
        makeUserOp({
          sender: SENDER_A,
          nonce: `0x${(i + 1).toString(16)}`,
        }),
        ENTRY_POINT_V08,
      );
      allHashes.push(hash);
    }

    // Bundle in batches of 10
    let bundleCount = 0;
    let processedCount = 0;

    while (stack.bundlerService.getPendingUserOperationsCount() > 0) {
      const bundle = stack.bundlerService.createBundle(10);
      if (bundle === null) break;

      bundleCount++;
      processedCount += bundle.userOperationHashes.length;

      stack.bundlerService.markBundleSubmitted(bundle.bundleHash, {
        transactionHash: `0x${bundleCount.toString(16).padStart(64, "0")}`,
        blockNumber: 1000 + bundleCount,
        success: true,
      });
    }

    expect(bundleCount).toBe(5);
    expect(processedCount).toBe(50);

    // All should have receipts
    for (const hash of allHashes) {
      const receipt = stack.bundlerService.getUserOperationReceipt(hash);
      expect(receipt).not.toBeNull();
      expect(receipt!.success).toBe(true);
    }
  });

  it("handles concurrent gas estimations without interference", async () => {
    const stack = createTestStack();

    const estimations = Array.from({ length: 50 }, (_, i) =>
      stack.sdk.ethEstimateUserOperationGas(
        makeUserOp({
          sender: SENDER_A,
          nonce: `0x${(i + 1).toString(16)}`,
          callData: `0x${"ab".repeat(i + 1)}`,
        }),
        ENTRY_POINT_V08,
      ),
    );

    const results = await Promise.all(estimations);

    expect(results).toHaveLength(50);

    for (const est of results) {
      expect(BigInt(est.callGasLimit)).toBeGreaterThan(0n);
      expect(BigInt(est.verificationGasLimit)).toBeGreaterThan(0n);
      expect(BigInt(est.preVerificationGas)).toBeGreaterThan(0n);
    }
  });

  it("concurrent quote requests return valid results", async () => {
    const stack = createTestStack();

    const quotes = Array.from({ length: 20 }, (_, i) =>
      stack.sdk.getUsdcQuote({
        sender: SENDER_A,
        chain: "taikoMainnet",
        entryPoint: ENTRY_POINT_V08,
        token: "USDC",
        userOperation: makeUserOp({
          nonce: `0x${(i + 1).toString(16)}`,
        }),
      }),
    );

    const results = await Promise.all(quotes);

    expect(results).toHaveLength(20);

    const quoteIds = new Set(results.map((q) => q.quoteId));
    expect(quoteIds.size).toBe(20); // Each quote should be unique

    for (const quote of results) {
      expect(quote.chain).toBe("taikoMainnet");
      expect(Number(quote.maxTokenCostMicros)).toBeGreaterThan(0);
    }
  });
});
