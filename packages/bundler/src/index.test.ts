import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { packPaymasterAndData } from "@agent-paymaster/shared";
import {
  BundlerService,
  createBundlerApp,
  type BundlerPersistence,
  type UserOperation,
} from "./index.js";

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
): response is {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string };
} => "error" in response;

class FakeBundlerPersistence implements BundlerPersistence {
  readonly pendingOperations = new Map<
    string,
    {
      entryPoint: HexString;
      userOperation: UserOperation;
      receivedAt: number;
      state: "pending" | "submitting";
      submissionTxHash: HexString | null;
      submissionStartedAt: number | null;
    }
  >();
  readonly senderReputations = new Map<string, { failures: number; bannedUntil: number | null }>();

  savePendingOperation(
    hash: string,
    entryPoint: HexString,
    userOperation: UserOperation,
    receivedAt: number,
  ): void {
    this.pendingOperations.set(hash, {
      entryPoint,
      userOperation,
      receivedAt,
      state: "pending",
      submissionTxHash: null,
      submissionStartedAt: null,
    });
  }

  markPendingOperationSubmitting(hash: string, startedAt: number): void {
    const existing = this.pendingOperations.get(hash);
    if (!existing) {
      return;
    }

    existing.state = "submitting";
    existing.submissionStartedAt = startedAt;
    existing.submissionTxHash = null;
  }

  recordPendingOperationsTransactionHash(hashes: string[], transactionHash: HexString): void {
    for (const hash of hashes) {
      const existing = this.pendingOperations.get(hash);
      if (!existing) {
        continue;
      }

      existing.state = "submitting";
      existing.submissionTxHash = transactionHash;
    }
  }

  markPendingOperationPending(hash: string): void {
    const existing = this.pendingOperations.get(hash);
    if (!existing) {
      return;
    }

    existing.state = "pending";
    existing.submissionTxHash = null;
    existing.submissionStartedAt = null;
  }

  removePendingOperation(hash: string): void {
    this.pendingOperations.delete(hash);
  }

  loadPendingOperations(): Array<{
    hash: string;
    entryPoint: HexString;
    userOperation: UserOperation;
    receivedAt: number;
    state: "pending" | "submitting";
    submissionTxHash: HexString | null;
    submissionStartedAt: number | null;
  }> {
    return [...this.pendingOperations.entries()].map(([hash, value]) => ({
      hash,
      entryPoint: value.entryPoint,
      userOperation: value.userOperation,
      receivedAt: value.receivedAt,
      state: value.state,
      submissionTxHash: value.submissionTxHash,
      submissionStartedAt: value.submissionStartedAt,
    }));
  }

  saveSenderReputation(sender: string, failures: number, bannedUntil: number | null): void {
    this.senderReputations.set(sender, { failures, bannedUntil });
  }

  deleteSenderReputation(sender: string): void {
    this.senderReputations.delete(sender);
  }

  loadSenderReputations(): Array<{ sender: string; failures: number; bannedUntil: number | null }> {
    return [...this.senderReputations.entries()].map(([sender, value]) => ({
      sender,
      failures: value.failures,
      bannedUntil: value.bannedUntil,
    }));
  }

  deleteExpiredSenderReputations(nowMs: number = Date.now()): void {
    for (const [sender, reputation] of this.senderReputations.entries()) {
      if (reputation.bannedUntil !== null && reputation.bannedUntil <= nowMs) {
        this.senderReputations.delete(sender);
      }
    }
  }
}

describe("BundlerService", () => {
  let service: BundlerService;

  it("defaults to the canonical Taiko entry point", () => {
    const defaultService = new BundlerService();
    expect(defaultService.getSupportedEntryPoints()).toEqual([ENTRY_POINT_V08]);
  });

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

    expect(estimate.callGasLimit).toBe("0xd6f8");
    expect(estimate.verificationGasLimit).toBe("0x1d4c8");
    expect(estimate.preVerificationGas).toBe("0x5274");
    expect(estimate.paymasterVerificationGasLimit).toBe("0x1d4c0");
    expect(estimate.paymasterPostOpGasLimit).toBe("0x13880");
  });

  it("charges initCode byte cost against verification gas, not call gas", () => {
    const estimate = service.estimateUserOperationGas(
      buildUserOperation({ initCode: "0x1234" }),
      ENTRY_POINT_V08,
    );

    expect(estimate.callGasLimit).toBe("0xd6f8");
    expect(estimate.verificationGasLimit).toBe("0x1d4d8");
  });

  it("stores pending user operations and resolves lookups", () => {
    const userOpHash = service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V08);
    const lookup = service.getUserOperationByHash(userOpHash);

    expect(lookup).not.toBeNull();
    expect(lookup?.entryPoint).toBe(ENTRY_POINT_V08);
    expect(lookup?.transactionHash).toBeNull();
    expect(service.getPendingUserOperationsCount()).toBe(1);
  });

  it("claims pending operations for submission by entry point", () => {
    const firstHash = service.sendUserOperation(
      buildUserOperation({ nonce: "0x1" }),
      ENTRY_POINT_V08,
    );
    service.sendUserOperation(buildUserOperation({ nonce: "0x2" }), ENTRY_POINT_V07);
    const thirdHash = service.sendUserOperation(
      buildUserOperation({ nonce: "0x3" }),
      ENTRY_POINT_V08,
    );

    const claim = service.claimPendingUserOperations(10);

    expect(claim).not.toBeNull();
    expect(claim?.entryPoint).toBe(ENTRY_POINT_V08);
    expect(claim?.userOperations.map((operation) => operation.hash)).toEqual([
      firstHash,
      thirdHash,
    ]);
    expect(service.getPendingUserOperationsCount()).toBe(1);
    expect(service.getSubmittingUserOperationsCount()).toBe(2);
  });

  it("records submission tx hashes and can release a claimed operation", () => {
    const hash = service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V08);
    const claim = service.claimPendingUserOperations(1);

    expect(claim?.userOperations[0]?.hash).toBe(hash);

    service.recordUserOperationsSubmissionTxHash(
      [hash],
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    expect(service.getSubmittingUserOperations()[0]?.submissionTxHash).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    service.releaseUserOperations([hash]);

    expect(service.getPendingUserOperationsCount()).toBe(1);
    expect(service.getSubmittingUserOperationsCount()).toBe(0);
  });

  it("uses canonical ERC-4337 userOpHash and ignores signature field", () => {
    const userOperation = buildUserOperation();
    const hash = service.sendUserOperation(userOperation, ENTRY_POINT_V08);

    const sameUserOpDifferentSignature = service.sendUserOperation(
      buildUserOperation({ signature: "0x123456" }),
      ENTRY_POINT_V08,
    );

    const legacyHash = `0x${createHash("sha256")
      .update(
        JSON.stringify({
          chainId: 167000,
          entryPoint: ENTRY_POINT_V08,
          userOperation: {
            sender: userOperation.sender.toLowerCase(),
            nonce: userOperation.nonce,
            initCode: userOperation.initCode,
            callData: userOperation.callData,
            callGasLimit: "0x",
            verificationGasLimit: "0x",
            preVerificationGas: "0x",
            maxFeePerGas: userOperation.maxFeePerGas,
            maxPriorityFeePerGas: userOperation.maxPriorityFeePerGas,
            paymasterAndData: "0x",
            signature: userOperation.signature,
            l1DataGas: "0x",
          },
        }),
      )
      .digest("hex")}`;

    expect(sameUserOpDifferentSignature).toBe(hash);
    expect(hash).not.toBe(legacyHash);
  });

  it("rejects a second pending operation with the same sender and nonce", () => {
    service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V08);

    expect(() =>
      service.sendUserOperation(
        buildUserOperation({ nonce: "0x01", callData: "0xabcd" }),
        ENTRY_POINT_V08,
      ),
    ).toThrow("Conflicting pending operation");
  });

  it("rejects empty signatures", () => {
    expect(() =>
      service.sendUserOperation(buildUserOperation({ signature: "0x" }), ENTRY_POINT_V08),
    ).toThrow("signature must not be empty");
  });

  it("rejects user operation submissions when automatic submission is disabled", () => {
    const readOnlyService = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V08],
      acceptUserOperations: false,
    });

    expect(() => readOnlyService.sendUserOperation(buildUserOperation(), ENTRY_POINT_V08)).toThrow(
      "Automatic submission is disabled",
    );
  });

  it("normalizes legacy and packed paymasterAndData to the same canonical userOp hash", () => {
    const legacy = buildUserOperation({
      paymasterVerificationGasLimit: "0xea60",
      paymasterPostOpGasLimit: "0xafc8",
      paymasterAndData: "0x9999999999999999999999999999999999999999abcd",
    });

    const hashFromLegacy = service.sendUserOperation(legacy, ENTRY_POINT_V08);
    const hashFromPacked = service.sendUserOperation(
      buildUserOperation({
        paymasterVerificationGasLimit: "0xea60",
        paymasterPostOpGasLimit: "0xafc8",
        paymasterAndData: packPaymasterAndData({
          paymaster: "0x9999999999999999999999999999999999999999",
          paymasterVerificationGasLimit: 0xea60n,
          paymasterPostOpGasLimit: 0xafc8n,
          paymasterData: "0xabcd",
        }),
      }),
      ENTRY_POINT_V08,
    );

    expect(hashFromPacked).toBe(hashFromLegacy);
  });

  it("derives missing paymaster gas limits from packed paymasterAndData", () => {
    const hash = service.sendUserOperation(
      buildUserOperation({
        paymasterAndData: packPaymasterAndData({
          paymaster: "0x9999999999999999999999999999999999999999",
          paymasterVerificationGasLimit: 0xea60n,
          paymasterPostOpGasLimit: 0xafc8n,
          paymasterData: "0xabcd",
        }),
      }),
      ENTRY_POINT_V08,
    );

    const lookup = service.getUserOperationByHash(hash);

    expect(lookup?.userOperation.paymasterVerificationGasLimit).toBe("0xea60");
    expect(lookup?.userOperation.paymasterPostOpGasLimit).toBe("0xafc8");
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
      gasUsed: "0x1000",
      gasCost: "0x10000",
      success: true,
    });

    const lookup = service.getUserOperationByHash(userOpHash);
    const receipt = service.getUserOperationReceipt(userOpHash);

    expect(lookup?.transactionHash).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(lookup?.blockNumber).toBe("0x63");
    expect(receipt?.success).toBe(true);
    expect(receipt?.actualGasUsed).toBe("0x1000");
    expect(receipt?.actualGasCost).toBe("0x10000");
    expect(receipt?.receipt.effectiveGasPrice).toBe("0x10");
    expect(receipt?.receipt.status).toBe("0x1");
    expect(receipt?.receipt.blockNumber).toBe("0x63");
  });

  it("stores failed bundle submission reason from revert metadata", () => {
    const userOpHash = service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V08);
    const bundle = service.createBundle(1);
    if (!bundle) {
      throw new Error("expected bundle to be created");
    }

    service.markBundleSubmitted(bundle.bundleHash, {
      transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      blockNumber: 100,
      gasUsed: "0x2000",
      gasCost: "0x40000",
      success: false,
      revertReason: "AA23 reverted",
    });

    const receipt = service.getUserOperationReceipt(userOpHash);

    expect(receipt?.success).toBe(false);
    expect(receipt?.reason).toBe("AA23 reverted");
    expect(receipt?.receipt.status).toBe("0x0");
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

  it("reloads pending operations and sender bans from persistence", () => {
    const persistence = new FakeBundlerPersistence();
    const firstService = new BundlerService(
      {
        chainId: 167000,
        entryPoints: [ENTRY_POINT_V08, ENTRY_POINT_V07],
        reputationMaxFailures: 3,
        banWindowMs: 60_000,
      },
      persistence,
    );

    const pendingUserOp = buildUserOperation({ nonce: "0x99" });
    const pendingHash = firstService.sendUserOperation(pendingUserOp, ENTRY_POINT_V08);

    const invalidUserOp = {
      sender: "0x2222222222222222222222222222222222222222",
      callData: "0x1234",
    };

    for (let index = 0; index < 3; index += 1) {
      firstService.handleJsonRpc({
        jsonrpc: "2.0",
        id: index,
        method: "eth_sendUserOperation",
        params: [invalidUserOp, ENTRY_POINT_V08],
      });
    }

    const secondService = new BundlerService(
      {
        chainId: 167000,
        entryPoints: [ENTRY_POINT_V08, ENTRY_POINT_V07],
        reputationMaxFailures: 3,
        banWindowMs: 60_000,
      },
      persistence,
    );

    expect(secondService.getUserOperationByHash(pendingHash)?.entryPoint).toBe(ENTRY_POINT_V08);
    expect(secondService.getPendingUserOperationsCount()).toBe(1);

    expect(() =>
      secondService.sendUserOperation(
        buildUserOperation({
          sender: "0x2222222222222222222222222222222222222222",
          nonce: "0x10",
        }),
        ENTRY_POINT_V08,
      ),
    ).toThrow("Sender is temporarily banned");
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

  it("returns HTTP 200 for JSON-RPC errors", async () => {
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
        id: 2,
        method: "eth_unknownMethod",
        params: [],
      }),
    });

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      jsonrpc: string;
      id: number;
      error: { code: number };
    };

    expect(payload.jsonrpc).toBe("2.0");
    expect(payload.id).toBe(2);
    expect(payload.error.code).toBe(-32601);
  });
});
