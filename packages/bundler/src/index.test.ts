import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { packPaymasterAndData, SERVO_SUPPORTED_ENTRY_POINTS } from "@agent-paymaster/shared";
import {
  type AdmissionSimulator,
  BundlerService,
  type CallGasEstimator,
  createBundlerApp,
  type BundlerPersistence,
  type HexString,
  type GasSimulator,
  type UserOperationReceiptLog,
  type UserOperation,
} from "./index.js";

const ENTRY_POINT_V07 = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const ENTRY_POINT_V06 = "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789";

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
  response: Awaited<ReturnType<BundlerService["handleJsonRpc"]>>,
): response is {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string };
} => "error" in response;

class FakeGasSimulator implements GasSimulator {
  constructor(private readonly simulatedPreOpGas: bigint) {}

  estimatePreOpGas(
    _userOperation: UserOperation,
    _entryPoint: `0x${string}`,
    _baseline: {
      callGasLimit: `0x${string}`;
      verificationGasLimit: `0x${string}`;
      preVerificationGas: `0x${string}`;
      paymasterVerificationGasLimit: `0x${string}`;
      paymasterPostOpGasLimit: `0x${string}`;
    },
  ): Promise<bigint> {
    void _userOperation;
    void _entryPoint;
    void _baseline;
    return Promise.resolve(this.simulatedPreOpGas);
  }
}

class ThrowingGasSimulator implements GasSimulator {
  estimatePreOpGas(..._args: Parameters<GasSimulator["estimatePreOpGas"]>): Promise<bigint> {
    void _args;
    throw new Error("simulateValidation unavailable");
  }
}

class FakeCallGasEstimator implements CallGasEstimator {
  constructor(private readonly result: bigint | null) {}

  estimateCallGas(
    _sender: `0x${string}`,
    _callData: `0x${string}`,
    _entryPoint: `0x${string}`,
  ): Promise<bigint | null> {
    void _sender;
    void _callData;
    void _entryPoint;
    return Promise.resolve(this.result);
  }
}

class ThrowingCallGasEstimator implements CallGasEstimator {
  estimateCallGas(
    _sender: `0x${string}`,
    _callData: `0x${string}`,
    _entryPoint: `0x${string}`,
  ): Promise<bigint | null> {
    void _sender;
    void _callData;
    void _entryPoint;
    throw new Error("eth_estimateGas unavailable");
  }
}

class PassingAdmissionSimulator implements AdmissionSimulator {
  simulateValidation(_userOperation: UserOperation, _entryPoint: `0x${string}`): Promise<void> {
    void _userOperation;
    void _entryPoint;
    return Promise.resolve();
  }
}

class RejectingAdmissionSimulator implements AdmissionSimulator {
  constructor(private readonly message: string) {}

  simulateValidation(_userOperation: UserOperation, _entryPoint: `0x${string}`): Promise<void> {
    void _userOperation;
    void _entryPoint;
    return Promise.reject(new Error(this.message));
  }
}

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
  readonly finalizedOperations = new Map<
    string,
    {
      entryPoint: HexString;
      userOperation: UserOperation;
      receivedAt: number;
      state: "included" | "failed";
      finalizedAt: number;
      transactionHash: HexString | null;
      blockNumber: number | null;
      blockHash: HexString | null;
      reason: string | null;
      gasUsed: bigint | null;
      gasCost: bigint | null;
      effectiveGasPrice: bigint | null;
      receiptLogs: UserOperationReceiptLog[] | null;
    }
  >();
  readonly senderReputations = new Map<
    string,
    {
      failures: number;
      windowStartedAt: number | null;
      throttledUntil: number | null;
      bannedUntil: number | null;
    }
  >();

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

  saveFinalizedOperation(operation: {
    hash: string;
    entryPoint: HexString;
    userOperation: UserOperation;
    receivedAt: number;
    state: "included" | "failed";
    finalizedAt: number;
    transactionHash: HexString | null;
    blockNumber: number | null;
    blockHash: HexString | null;
    reason: string | null;
    gasUsed: bigint | null;
    gasCost: bigint | null;
    effectiveGasPrice: bigint | null;
    receiptLogs: UserOperationReceiptLog[] | null;
  }): void {
    this.finalizedOperations.set(operation.hash, {
      entryPoint: operation.entryPoint,
      userOperation: operation.userOperation,
      receivedAt: operation.receivedAt,
      state: operation.state,
      finalizedAt: operation.finalizedAt,
      transactionHash: operation.transactionHash,
      blockNumber: operation.blockNumber,
      blockHash: operation.blockHash,
      reason: operation.reason,
      gasUsed: operation.gasUsed,
      gasCost: operation.gasCost,
      effectiveGasPrice: operation.effectiveGasPrice,
      receiptLogs: operation.receiptLogs,
    });
  }

  deleteFinalizedOperation(hash: string): void {
    this.finalizedOperations.delete(hash);
  }

  loadFinalizedOperations(): Array<{
    hash: string;
    entryPoint: HexString;
    userOperation: UserOperation;
    receivedAt: number;
    state: "included" | "failed";
    finalizedAt: number;
    transactionHash: HexString | null;
    blockNumber: number | null;
    blockHash: HexString | null;
    reason: string | null;
    gasUsed: bigint | null;
    gasCost: bigint | null;
    effectiveGasPrice: bigint | null;
    receiptLogs: UserOperationReceiptLog[] | null;
  }> {
    return [...this.finalizedOperations.entries()].map(([hash, value]) => ({
      hash,
      entryPoint: value.entryPoint,
      userOperation: value.userOperation,
      receivedAt: value.receivedAt,
      state: value.state,
      finalizedAt: value.finalizedAt,
      transactionHash: value.transactionHash,
      blockNumber: value.blockNumber,
      blockHash: value.blockHash,
      reason: value.reason,
      gasUsed: value.gasUsed,
      gasCost: value.gasCost,
      effectiveGasPrice: value.effectiveGasPrice,
      receiptLogs: value.receiptLogs,
    }));
  }

  pruneFinalizedOperations(maxEntries: number): string[] {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      return [];
    }

    const finalized = [...this.finalizedOperations.entries()]
      .map(([hash, value]) => ({
        hash,
        finalizedAt: value.finalizedAt,
      }))
      .sort((left, right) => right.finalizedAt - left.finalizedAt);

    const deleted = finalized.slice(maxEntries).map((entry) => entry.hash);
    for (const hash of deleted) {
      this.finalizedOperations.delete(hash);
    }

    return deleted;
  }

  saveSenderReputation(
    sender: string,
    failures: number,
    windowStartedAt: number | null,
    throttledUntil: number | null,
    bannedUntil: number | null,
  ): void {
    this.senderReputations.set(sender, {
      failures,
      windowStartedAt,
      throttledUntil,
      bannedUntil,
    });
  }

  deleteSenderReputation(sender: string): void {
    this.senderReputations.delete(sender);
  }

  loadSenderReputations(): Array<{
    sender: string;
    failures: number;
    windowStartedAt: number | null;
    throttledUntil: number | null;
    bannedUntil: number | null;
  }> {
    return [...this.senderReputations.entries()].map(([sender, value]) => ({
      sender,
      failures: value.failures,
      windowStartedAt: value.windowStartedAt,
      throttledUntil: value.throttledUntil,
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

  it("defaults to the canonical Taiko entry point", async () => {
    const defaultService = new BundlerService();
    expect(defaultService.getSupportedEntryPoints()).toEqual([ENTRY_POINT_V07]);
  });

  beforeEach(() => {
    service = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07, ENTRY_POINT_V06],
      reputationBanFailures: 5,
      reputationThrottleFailures: 3,
      banWindowMs: 60_000,
      admissionSimulator: new PassingAdmissionSimulator(),
    });
  });

  it("returns service health", async () => {
    const health = service.getHealth();

    expect(health.service).toBe("bundler");
    expect(health.status).toBe("ok");
    expect(health.chainId).toBe(167000);
    expect(health.entryPoints).toEqual([ENTRY_POINT_V07, ENTRY_POINT_V06]);
    expect(health.mempoolDepth).toEqual({
      pending: 0,
      submitting: 0,
      total: 0,
    });
    expect(health.operationalMetrics.userOpsAcceptedTotal).toBe(0);
    expect(health.operationalMetrics.userOpsIncludedTotal).toBe(0);
    expect(health.operationalMetrics.userOpsFailedTotal).toBe(0);
    expect(health.operationalMetrics.acceptanceToInclusionSuccessRate).toBe(0);
    expect(health.operationalMetrics.averageAcceptanceToInclusionMs).toBe(0);
  });

  it("tracks mempool age distribution and lifecycle counters", async () => {
    const pendingHash = await service.sendUserOperation(
      buildUserOperation({ nonce: "0x10" }),
      ENTRY_POINT_V07,
    );
    const revertedHash = await service.sendUserOperation(
      buildUserOperation({ nonce: "0x11" }),
      ENTRY_POINT_V07,
    );
    const includedHash = await service.sendUserOperation(
      buildUserOperation({ nonce: "0x12" }),
      ENTRY_POINT_V07,
    );

    const queuedHealth = service.getHealth();
    expect(queuedHealth.mempoolDepth).toEqual({
      pending: 3,
      submitting: 0,
      total: 3,
    });
    expect(queuedHealth.mempoolAgeDistribution.pending.le_30000ms).toBe(3);

    service.markUserOperationFailed(revertedHash, "simulation_failed");
    service.finalizeUserOperation(includedHash, {
      transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      blockHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      blockNumber: 120,
      gasUsed: "0x1000",
      gasCost: "0x2000",
      success: true,
    });
    service.finalizeUserOperation(pendingHash, {
      transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      blockHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      blockNumber: 121,
      gasUsed: "0x900",
      gasCost: "0x1200",
      success: false,
      revertReason: "AA23 reverted",
    });

    const health = service.getHealth();

    expect(health.mempoolDepth).toEqual({
      pending: 0,
      submitting: 0,
      total: 0,
    });
    expect(health.operationalMetrics.userOpsAcceptedTotal).toBe(3);
    expect(health.operationalMetrics.userOpsIncludedTotal).toBe(1);
    expect(health.operationalMetrics.userOpsFailedTotal).toBe(2);
    expect(health.operationalMetrics.acceptanceToInclusionSuccessRate).toBeCloseTo(1 / 3, 6);
    expect(health.operationalMetrics.averageAcceptanceToInclusionMs).toBeGreaterThanOrEqual(0);
    expect(health.operationalMetrics.simulationFailureReasons).toEqual({
      simulation_failed: 1,
    });
    expect(health.operationalMetrics.revertReasons).toEqual({
      AA23_reverted: 1,
    });
  });

  it("defaults to shared supported entry points when none are configured", async () => {
    const defaultService = new BundlerService();
    const expected = Array.isArray(SERVO_SUPPORTED_ENTRY_POINTS)
      ? [...SERVO_SUPPORTED_ENTRY_POINTS]
      : [ENTRY_POINT_V07];
    expect(defaultService.getSupportedEntryPoints()).toEqual(expected);
  });

  it("estimates gas including taiko l1 data gas contribution", async () => {
    const estimate = await service.estimateUserOperationGas(
      buildUserOperation({ l1DataGas: "0x64" }),
      ENTRY_POINT_V07,
    );

    expect(estimate.callGasLimit).toBe("0xd6f8");
    expect(estimate.verificationGasLimit).toBe("0x1d4c8");
    expect(estimate.preVerificationGas).toBe("0x5274");
    expect(estimate.paymasterVerificationGasLimit).toBe("0x30d40");
    expect(estimate.paymasterPostOpGasLimit).toBe("0x13880");
  });

  it("applies initCode deploy gas floor to verification gas", async () => {
    const estimate = await service.estimateUserOperationGas(
      buildUserOperation({ initCode: "0x1234" }),
      ENTRY_POINT_V07,
    );

    expect(estimate.callGasLimit).toBe("0xd6f8");
    // 120000 + (2*4) + (2*8) + 500000 (deploy floor) = 620024 = 0x975f8
    expect(estimate.verificationGasLimit).toBe("0x975f8");
  });

  it("uses simulation preOpGas to raise verification gas for deployed accounts", async () => {
    const serviceWithSimulation = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
      gasSimulator: new FakeGasSimulator(300_000n),
    });

    const estimate = await serviceWithSimulation.estimateUserOperationGas(
      buildUserOperation(),
      ENTRY_POINT_V07,
    );

    expect(estimate.verificationGasLimit).toBe("0x441d0");
  });

  it("uses simulation preOpGas to raise verification gas above initCode floor", async () => {
    // Simulation must exceed the deploy floor (620040) + preVerificationGas (21008)
    const serviceWithSimulation = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
      gasSimulator: new FakeGasSimulator(750_000n),
    });

    const estimate = await serviceWithSimulation.estimateUserOperationGas(
      buildUserOperation({ initCode: "0x12345678" }),
      ENTRY_POINT_V07,
    );

    // simulatedVerificationGas = 750000 - 21008 = 728992 > 620040 (floor)
    expect(estimate.verificationGasLimit).toBe("0xb1fa0");
  });

  it("falls back to heuristic estimates when simulation fails", async () => {
    const serviceWithFailingSimulation = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
      gasSimulator: new ThrowingGasSimulator(),
    });

    const estimate = await serviceWithFailingSimulation.estimateUserOperationGas(
      buildUserOperation({ initCode: "0x1234" }),
      ENTRY_POINT_V07,
    );

    expect(estimate.callGasLimit).toBe("0xd6f8");
    // Falls back to heuristic with deploy floor: 120024 + 500000 = 620024 = 0x975f8
    expect(estimate.verificationGasLimit).toBe("0x975f8");
    expect(estimate.preVerificationGas).toBe("0x5210");
  });

  it("accepts v0.7 factory/factoryData fields", async () => {
    const factory = "0x4055ec5bf8f7910A23F9eBFba38421c5e24E2716";
    const factoryData = "0xabcdef";
    const estimate = await service.estimateUserOperationGas(
      {
        sender: "0x1111111111111111111111111111111111111111",
        nonce: "0x1",
        factory,
        factoryData,
        callData: "0x1234",
        maxFeePerGas: "0x100",
        maxPriorityFeePerGas: "0x10",
        signature: "0x99",
      } as unknown as UserOperation,
      ENTRY_POINT_V07,
    );

    // callData(2 bytes) × 4 + initCode(23 bytes) × 8 + base(120000) + deploy(500000)
    // = 8 + 184 + 120000 + 500000 = 620192 = 0x976a0
    expect(estimate.verificationGasLimit).toBe("0x976a0");
  });

  it("accepts legacy initCode field", async () => {
    const estimate = await service.estimateUserOperationGas(
      buildUserOperation({ initCode: "0x1234" }),
      ENTRY_POINT_V07,
    );

    // Same behavior as before — initCode triggers deploy gas floor
    expect(estimate.verificationGasLimit).toBe("0x975f8");
  });

  it("defaults to 0x when neither initCode nor factory is provided", async () => {
    const estimate = await service.estimateUserOperationGas(
      {
        sender: "0x1111111111111111111111111111111111111111",
        nonce: "0x1",
        callData: "0x1234",
        maxFeePerGas: "0x100",
        maxPriorityFeePerGas: "0x10",
        signature: "0x99",
      } as unknown as UserOperation,
      ENTRY_POINT_V07,
    );

    // No initCode — no deploy gas floor
    expect(estimate.verificationGasLimit).toBe("0x1d4c8");
  });

  it("rejects when both initCode and factory are provided", async () => {
    await expect(
      service.estimateUserOperationGas(
        {
          sender: "0x1111111111111111111111111111111111111111",
          nonce: "0x1",
          initCode: "0x1234",
          factory: "0x4055ec5bf8f7910A23F9eBFba38421c5e24E2716",
          callData: "0x1234",
          maxFeePerGas: "0x100",
          maxPriorityFeePerGas: "0x10",
          signature: "0x99",
        } as unknown as UserOperation,
        ENTRY_POINT_V07,
      ),
    ).rejects.toThrow("Provide either initCode or factory/factoryData, not both");
  });

  it("uses call gas estimator when available", async () => {
    const serviceWithCallGas = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
      callGasEstimator: new FakeCallGasEstimator(200_000n),
    });

    const estimate = await serviceWithCallGas.estimateUserOperationGas(
      buildUserOperation(),
      ENTRY_POINT_V07,
    );

    // 200000 = 0x30d40
    expect(estimate.callGasLimit).toBe("0x30d40");
  });

  it("scales heuristic when call gas estimator returns null", async () => {
    const serviceWithNullEstimator = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
      callGasEstimator: new FakeCallGasEstimator(null),
    });

    const estimate = await serviceWithNullEstimator.estimateUserOperationGas(
      buildUserOperation(),
      ENTRY_POINT_V07,
    );

    // Heuristic: 55000 + 2*16 = 55032. Multiplied by 3: 165096 = 0x284e8
    expect(estimate.callGasLimit).toBe("0x284e8");
  });

  it("scales heuristic when call gas estimator throws", async () => {
    const serviceWithThrowingEstimator = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
      callGasEstimator: new ThrowingCallGasEstimator(),
    });

    const estimate = await serviceWithThrowingEstimator.estimateUserOperationGas(
      buildUserOperation(),
      ENTRY_POINT_V07,
    );

    // Same as null case — heuristic × 3
    expect(estimate.callGasLimit).toBe("0x284e8");
  });

  it("respects client-provided callGasLimit even with call gas estimator", async () => {
    const serviceWithCallGas = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
      callGasEstimator: new FakeCallGasEstimator(200_000n),
    });

    const estimate = await serviceWithCallGas.estimateUserOperationGas(
      buildUserOperation({ callGasLimit: "0x50000" }),
      ENTRY_POINT_V07,
    );

    // Client provided 0x50000 (327680) — should be used as-is
    expect(estimate.callGasLimit).toBe("0x50000");
  });

  it("applies custom heuristic multiplier when estimator returns null", async () => {
    const serviceWithCustomConfig = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
      callGasEstimator: new FakeCallGasEstimator(null),
      callGasHeuristicMultiplier: 5n,
    });

    const estimate = await serviceWithCustomConfig.estimateUserOperationGas(
      buildUserOperation(),
      ENTRY_POINT_V07,
    );

    // Heuristic: 55032. Multiplied by 5: 275160 = 0x432d8
    expect(estimate.callGasLimit).toBe("0x432d8");
  });

  it("stores pending user operations and resolves lookups", async () => {
    const userOpHash = await service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V07);
    const lookup = service.getUserOperationByHash(userOpHash);

    expect(lookup).not.toBeNull();
    expect(lookup?.entryPoint).toBe(ENTRY_POINT_V07);
    expect(lookup?.transactionHash).toBeNull();
    expect(service.getPendingUserOperationsCount()).toBe(1);
  });

  it("claims pending operations for submission by entry point", async () => {
    const firstHash = await service.sendUserOperation(
      buildUserOperation({ nonce: "0x1" }),
      ENTRY_POINT_V07,
    );
    await service.sendUserOperation(buildUserOperation({ nonce: "0x2" }), ENTRY_POINT_V06);
    const thirdHash = await service.sendUserOperation(
      buildUserOperation({ nonce: "0x3" }),
      ENTRY_POINT_V07,
    );

    const claim = service.claimPendingUserOperations(10);

    expect(claim).not.toBeNull();
    expect(claim?.entryPoint).toBe(ENTRY_POINT_V07);
    expect(claim?.userOperations.map((operation) => operation.hash)).toEqual([
      firstHash,
      thirdHash,
    ]);
    expect(service.getPendingUserOperationsCount()).toBe(1);
    expect(service.getSubmittingUserOperationsCount()).toBe(2);
  });

  it("records submission tx hashes and can release a claimed operation", async () => {
    const hash = await service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V07);
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

  it("uses canonical ERC-4337 userOpHash and ignores signature field", async () => {
    const userOperation = buildUserOperation();
    const hash = await service.sendUserOperation(userOperation, ENTRY_POINT_V07);

    const sameUserOpDifferentSignature = await service.sendUserOperation(
      buildUserOperation({ signature: "0x123456" }),
      ENTRY_POINT_V07,
    );

    const legacyHash = `0x${createHash("sha256")
      .update(
        JSON.stringify({
          chainId: 167000,
          entryPoint: ENTRY_POINT_V07,
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

  it("rejects a second pending operation with the same sender and nonce", async () => {
    await service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V07);

    await expect(
      service.sendUserOperation(
        buildUserOperation({ nonce: "0x01", callData: "0xabcd" }),
        ENTRY_POINT_V07,
      ),
    ).rejects.toThrow("Conflicting pending operation");
  });

  it("rejects empty signatures", async () => {
    await expect(
      service.sendUserOperation(buildUserOperation({ signature: "0x" }), ENTRY_POINT_V07),
    ).rejects.toThrow("signature must not be empty");
  });

  it("rejects user operations with a mismatched chainId", async () => {
    await expect(
      service.sendUserOperation(
        {
          ...buildUserOperation(),
          chainId: 999999,
        },
        ENTRY_POINT_V07,
      ),
    ).rejects.toThrow("chainId must match bundler chainId");
  });

  it("does not enqueue user operations when admission simulation fails", async () => {
    const serviceWithFailingAdmission = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
      admissionSimulator: new RejectingAdmissionSimulator("AA23 reverted"),
    });

    await expect(
      serviceWithFailingAdmission.sendUserOperation(buildUserOperation(), ENTRY_POINT_V07),
    ).rejects.toThrow("validation failed");
    expect(serviceWithFailingAdmission.getPendingUserOperationsCount()).toBe(0);
  });

  it("rejects user operation submissions when automatic submission is disabled", async () => {
    const readOnlyService = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
      acceptUserOperations: false,
    });

    await expect(
      readOnlyService.sendUserOperation(buildUserOperation(), ENTRY_POINT_V07),
    ).rejects.toThrow("Automatic submission is disabled");
  });

  it("normalizes legacy and packed paymasterAndData to the same canonical userOp hash", async () => {
    const legacy = buildUserOperation({
      paymasterVerificationGasLimit: "0xea60",
      paymasterPostOpGasLimit: "0xafc8",
      paymasterAndData: "0x9999999999999999999999999999999999999999abcd",
    });

    const hashFromLegacy = await service.sendUserOperation(legacy, ENTRY_POINT_V07);
    const hashFromPacked = await service.sendUserOperation(
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
      ENTRY_POINT_V07,
    );

    expect(hashFromPacked).toBe(hashFromLegacy);
  });

  it("derives missing paymaster gas limits from packed paymasterAndData", async () => {
    const hash = await service.sendUserOperation(
      buildUserOperation({
        paymasterAndData: packPaymasterAndData({
          paymaster: "0x9999999999999999999999999999999999999999",
          paymasterVerificationGasLimit: 0xea60n,
          paymasterPostOpGasLimit: 0xafc8n,
          paymasterData: "0xabcd",
        }),
      }),
      ENTRY_POINT_V07,
    );

    const lookup = service.getUserOperationByHash(hash);

    expect(lookup?.userOperation.paymasterVerificationGasLimit).toBe("0xea60");
    expect(lookup?.userOperation.paymasterPostOpGasLimit).toBe("0xafc8");
  });

  it("creates a bundle and publishes receipts after submission", async () => {
    const userOpHash = await service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V07);
    const bundle = service.createBundle(10);

    expect(bundle).not.toBeNull();
    expect(bundle?.userOperationHashes).toContain(userOpHash);

    service.markBundleSubmitted(bundle?.bundleHash ?? "", {
      transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      blockNumber: 99,
      blockHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
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
    expect(lookup?.blockHash).toBe(
      "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    );
    expect(receipt?.success).toBe(true);
    expect(receipt?.actualGasUsed).toBe("0x1000");
    expect(receipt?.actualGasCost).toBe("0x10000");
    expect(receipt?.receipt.effectiveGasPrice).toBe("0x10");
    expect(receipt?.receipt.status).toBe("0x1");
    expect(receipt?.receipt.blockNumber).toBe("0x63");
    expect(receipt?.receipt.blockHash).toBe(
      "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    );
    expect(receipt?.logs).toEqual([]);
    expect(receipt?.receipt.logs).toEqual([]);
  });

  it("stores failed bundle submission reason from revert metadata", async () => {
    const userOpHash = await service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V07);
    const bundle = service.createBundle(1);
    if (!bundle) {
      throw new Error("expected bundle to be created");
    }

    service.markBundleSubmitted(bundle.bundleHash, {
      transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      blockNumber: 100,
      blockHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
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

  it("requeues the same userOp hash after a failed attempt", async () => {
    const userOp = buildUserOperation();
    const userOpHash = await service.sendUserOperation(userOp, ENTRY_POINT_V07);

    service.markUserOperationFailed(userOpHash, "simulation_failed");
    expect(service.getPendingUserOperationsCount()).toBe(0);

    const retriedHash = await service.sendUserOperation(userOp, ENTRY_POINT_V07);
    expect(retriedHash).toBe(userOpHash);
    expect(service.getPendingUserOperationsCount()).toBe(1);
    expect(service.getUserOperationReceipt(userOpHash)).toBeNull();
  });

  it("does not penalize parse/shape errors", async () => {
    const invalidUserOp = {
      sender: "0x1111111111111111111111111111111111111111",
      callData: "0x1234",
    };

    for (let index = 0; index < 6; index += 1) {
      const errorResponse = await service.handleJsonRpc({
        jsonrpc: "2.0",
        id: index,
        method: "eth_sendUserOperation",
        params: [invalidUserOp, ENTRY_POINT_V07],
      });

      expect(isErrorResponse(errorResponse)).toBe(true);
      if (isErrorResponse(errorResponse)) {
        expect(errorResponse.error.code).toBe(-32602);
      }
    }

    const acceptedHash = await service.sendUserOperation(
      buildUserOperation({
        sender: "0x1111111111111111111111111111111111111111",
        nonce: "0x10",
      }),
      ENTRY_POINT_V07,
    );
    expect(typeof acceptedHash).toBe("string");
  });

  it("throttles after repeated deterministic validation failures", async () => {
    const throttledService = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
      reputationThrottleFailures: 3,
      reputationBanFailures: 5,
      throttleWindowMs: 60_000,
      admissionSimulator: new RejectingAdmissionSimulator("AA23 reverted"),
    });

    for (let index = 0; index < 3; index += 1) {
      await expect(
        throttledService.sendUserOperation(
          buildUserOperation({ nonce: `0x${index + 1}` }),
          ENTRY_POINT_V07,
        ),
      ).rejects.toThrow("validation failed");
    }

    await expect(
      throttledService.sendUserOperation(buildUserOperation({ nonce: "0x10" }), ENTRY_POINT_V07),
    ).rejects.toThrow("temporarily throttled");
  });

  it("reloads pending operations and sender bans from persistence", async () => {
    const persistence = new FakeBundlerPersistence();
    const firstService = new BundlerService(
      {
        chainId: 167000,
        entryPoints: [ENTRY_POINT_V07, ENTRY_POINT_V06],
        reputationBanFailures: 3,
        reputationThrottleFailures: 2,
        throttleWindowMs: 1,
        banWindowMs: 60_000,
        admissionSimulator: new PassingAdmissionSimulator(),
      },
      persistence,
    );

    const pendingUserOp = buildUserOperation({ nonce: "0x99" });
    const pendingHash = await firstService.sendUserOperation(pendingUserOp, ENTRY_POINT_V07);

    const failingSender = "0x2222222222222222222222222222222222222222";
    for (let index = 0; index < 3; index += 1) {
      const hash = await firstService.sendUserOperation(
        buildUserOperation({ sender: failingSender, nonce: `0x${index + 1}` }),
        ENTRY_POINT_V07,
      );
      firstService.markUserOperationFailed(hash, "simulation_failed");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const secondService = new BundlerService(
      {
        chainId: 167000,
        entryPoints: [ENTRY_POINT_V07, ENTRY_POINT_V06],
        reputationBanFailures: 3,
        reputationThrottleFailures: 2,
        throttleWindowMs: 1,
        banWindowMs: 60_000,
        admissionSimulator: new PassingAdmissionSimulator(),
      },
      persistence,
    );

    expect(secondService.getUserOperationByHash(pendingHash)?.entryPoint).toBe(ENTRY_POINT_V07);
    expect(secondService.getPendingUserOperationsCount()).toBe(1);

    await expect(
      secondService.sendUserOperation(
        buildUserOperation({
          sender: failingSender,
          nonce: "0x10",
        }),
        ENTRY_POINT_V07,
      ),
    ).rejects.toThrow("Sender is temporarily banned");
  });

  it("reloads finalized operation receipts from persistence", async () => {
    const persistence = new FakeBundlerPersistence();
    const firstService = new BundlerService(
      {
        chainId: 167000,
        entryPoints: [ENTRY_POINT_V07, ENTRY_POINT_V06],
      },
      persistence,
    );

    const userOpHash = await firstService.sendUserOperation(buildUserOperation(), ENTRY_POINT_V07);
    const bundle = firstService.createBundle(1);
    if (!bundle) {
      throw new Error("expected bundle to be created");
    }

    firstService.markBundleSubmitted(bundle.bundleHash, {
      transactionHash: "0xabababababababababababababababababababababababababababababababab",
      blockNumber: 321,
      blockHash: "0xefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
      gasUsed: "0x55",
      gasCost: "0xaa",
      effectiveGasPrice: "0x2",
      success: true,
    });

    const secondService = new BundlerService(
      {
        chainId: 167000,
        entryPoints: [ENTRY_POINT_V07, ENTRY_POINT_V06],
      },
      persistence,
    );

    const lookup = secondService.getUserOperationByHash(userOpHash);
    const receipt = secondService.getUserOperationReceipt(userOpHash);
    expect(lookup?.blockHash).toBe(
      "0xefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
    );
    expect(receipt?.receipt.blockHash).toBe(
      "0xefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
    );
    expect(receipt?.actualGasUsed).toBe("0x55");
    expect(receipt?.logs).toEqual([]);
  });

  it("restores finalized receipt logs from persistence", async () => {
    const persistence = new FakeBundlerPersistence();
    const firstService = new BundlerService(
      {
        chainId: 167000,
        entryPoints: [ENTRY_POINT_V07],
      },
      persistence,
    );

    const userOpHash = await firstService.sendUserOperation(buildUserOperation(), ENTRY_POINT_V07);
    const bundle = firstService.createBundle(1);
    if (!bundle) {
      throw new Error("expected bundle to be created");
    }

    firstService.markBundleSubmitted(bundle.bundleHash, {
      transactionHash: "0xabababababababababababababababababababababababababababababababab",
      blockNumber: 321,
      blockHash: "0xefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
      gasUsed: "0x55",
      gasCost: "0xaa",
      effectiveGasPrice: "0x2",
      success: true,
      logs: [
        {
          address: "0x1111111111111111111111111111111111111111",
          data: "0x1234",
          topics: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          blockNumber: "0x141",
          transactionIndex: "0x1",
          logIndex: "0x0",
        },
      ],
    });

    const secondService = new BundlerService(
      {
        chainId: 167000,
        entryPoints: [ENTRY_POINT_V07],
      },
      persistence,
    );

    const receipt = secondService.getUserOperationReceipt(userOpHash);
    expect(receipt?.logs).toEqual([
      {
        address: "0x1111111111111111111111111111111111111111",
        data: "0x1234",
        topics: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        blockNumber: "0x141",
        transactionIndex: "0x1",
        logIndex: "0x0",
      },
    ]);
    expect(receipt?.receipt.logs).toEqual(receipt?.logs);
  });

  it("prunes oldest finalized operations when retention limit is exceeded", async () => {
    const persistence = new FakeBundlerPersistence();
    const limitedService = new BundlerService(
      {
        chainId: 167000,
        entryPoints: [ENTRY_POINT_V07],
        maxFinalizedOperations: 2,
      },
      persistence,
    );

    const originalDateNow = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => {
      now += 1;
      return now;
    };

    const hashes: string[] = [];
    try {
      for (const nonce of ["0x1", "0x2", "0x3"]) {
        const hash = await limitedService.sendUserOperation(
          buildUserOperation({ nonce }),
          ENTRY_POINT_V07,
        );
        hashes.push(hash);
        limitedService.markUserOperationFailed(hash, `failed_${nonce}`);
      }
    } finally {
      Date.now = originalDateNow;
    }

    expect(persistence.finalizedOperations.size).toBe(2);
    expect(limitedService.getUserOperationByHash(hashes[0])).toBeNull();
    expect(limitedService.getUserOperationByHash(hashes[1])).not.toBeNull();
    expect(limitedService.getUserOperationByHash(hashes[2])).not.toBeNull();
  });

  it("returns json-rpc method not found for unknown methods", async () => {
    const response = await service.handleJsonRpc({
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
      entryPoints: [ENTRY_POINT_V07],
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
    expect(payload.result).toEqual([ENTRY_POINT_V07]);
  });

  it("returns HTTP 200 for JSON-RPC errors", async () => {
    const service = new BundlerService({
      entryPoints: [ENTRY_POINT_V07],
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
