import { beforeEach, describe, expect, it } from "vitest";

import { BundlerService, createBundlerApp, type UserOperation } from "./index.js";

const ENTRY_POINT_V08 = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const ENTRY_POINT_V07 = "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789";

const buildUserOperation = (overrides: Partial<UserOperation> = {}): UserOperation => ({
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "0x1",
  initCode: "0x",
  callData: "0x1234",
  maxFeePerGas: "0x100",
  maxPriorityFeePerGas: "0x10",
  signature: "0x99",
  ...overrides,
});

const isErrorResponse = (
  response: ReturnType<BundlerService["handleJsonRpc"]>,
): response is { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } } =>
  "error" in response;

describe("BundlerService", () => {
  let service: BundlerService;

  beforeEach(() => {
    service = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V08, ENTRY_POINT_V07],
      reputationMaxFailures: 3,
      banWindowMs: 60_000,
    });
  });

  it("returns service health", () => {
    const health = service.getHealth();

    expect(health.service).toBe("bundler");
    expect(health.status).toBe("ok");
    expect(health.chainId).toBe(167000);
    expect(health.entryPoints).toEqual([ENTRY_POINT_V08, ENTRY_POINT_V07]);
  });

  it("estimates gas including taiko l1 data gas contribution", () => {
    const estimate = service.estimateUserOperationGas(
      buildUserOperation({ l1DataGas: "0x64" }),
      ENTRY_POINT_V08,
    );

    expect(estimate.callGasLimit).toBe("0x88d8");
    expect(estimate.verificationGasLimit).toBe("0x1d4c8");
    expect(estimate.preVerificationGas).toBe("0x5274");
    expect(estimate.paymasterVerificationGasLimit).toBe("0xea60");
    expect(estimate.paymasterPostOpGasLimit).toBe("0xafc8");
  });

  it("stores pending user operations and resolves lookups", () => {
    const userOpHash = service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V08);
    const lookup = service.getUserOperationByHash(userOpHash);

    expect(lookup).not.toBeNull();
    expect(lookup?.entryPoint).toBe(ENTRY_POINT_V08);
    expect(lookup?.transactionHash).toBeNull();
    expect(service.getPendingUserOperationsCount()).toBe(1);
  });

  it("creates a bundle and publishes receipts after submission", () => {
    const userOpHash = service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V08);
    const bundle = service.createBundle(10);

    expect(bundle).not.toBeNull();
    expect(bundle?.userOperationHashes).toContain(userOpHash);

    service.markBundleSubmitted(bundle?.bundleHash ?? "", {
      transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      blockNumber: 99,
      effectiveGasPrice: "0x10",
      success: true,
    });

    const lookup = service.getUserOperationByHash(userOpHash);
    const receipt = service.getUserOperationReceipt(userOpHash);

    expect(lookup?.transactionHash).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(lookup?.blockNumber).toBe("0x63");
    expect(receipt?.success).toBe(true);
    expect(receipt?.receipt.status).toBe("0x1");
    expect(receipt?.receipt.blockNumber).toBe("0x63");
  });

  it("bans senders after repeated invalid user operations", () => {
    const invalidUserOp = {
      sender: "0x1111111111111111111111111111111111111111",
      callData: "0x1234",
    };

    for (let index = 0; index < 3; index += 1) {
      const errorResponse = service.handleJsonRpc({
        jsonrpc: "2.0",
        id: index,
        method: "eth_sendUserOperation",
        params: [invalidUserOp, ENTRY_POINT_V08],
      });

      expect(isErrorResponse(errorResponse)).toBe(true);
      if (isErrorResponse(errorResponse)) {
        expect(errorResponse.error.code).toBe(-32602);
      }
    }

    const bannedResponse = service.handleJsonRpc({
      jsonrpc: "2.0",
      id: "blocked",
      method: "eth_sendUserOperation",
      params: [buildUserOperation(), ENTRY_POINT_V08],
    });

    expect(isErrorResponse(bannedResponse)).toBe(true);
    if (isErrorResponse(bannedResponse)) {
      expect(bannedResponse.error.code).toBe(-32001);
    }
  });

  it("returns json-rpc method not found for unknown methods", () => {
    const response = service.handleJsonRpc({
      jsonrpc: "2.0",
      id: 42,
      method: "eth_notImplemented",
      params: [],
    });

    expect(isErrorResponse(response)).toBe(true);
    if (isErrorResponse(response)) {
      expect(response.error.code).toBe(-32601);
    }
  });
});

describe("createBundlerApp", () => {
  it("serves JSON-RPC over /rpc", async () => {
    const service = new BundlerService({
      entryPoints: [ENTRY_POINT_V08],
    });

    const app = createBundlerApp(service);
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

    const payload = (await response.json()) as {
      jsonrpc: string;
      id: number;
      result: string[];
    };

    expect(payload.jsonrpc).toBe("2.0");
    expect(payload.id).toBe(1);
    expect(payload.result).toEqual([ENTRY_POINT_V08]);
  });
});
