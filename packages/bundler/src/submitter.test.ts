import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";

import { ENTRY_POINT_ABI, type PackedUserOperation } from "./entrypoint.js";
import {
  BundlerService,
  type BundlerPersistence,
  type HexString,
  type UserOperationReceiptLog,
  type UserOperation,
} from "./index.js";
import {
  BundlerSubmitter,
  computeSimulationGasLimit,
  type SubmissionClient,
  type SubmissionReceipt,
} from "./submitter.js";

const ENTRY_POINT_V07 = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const buildUserOperation = (overrides: Partial<UserOperation> = {}): UserOperation => ({
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "0x1",
  initCode: "0x",
  callData: "0x1234",
  callGasLimit: "0x10000",
  verificationGasLimit: "0x10000",
  preVerificationGas: "0x10000",
  maxFeePerGas: "0x100",
  maxPriorityFeePerGas: "0x10",
  signature: "0x99",
  ...overrides,
});

class FakeSubmissionClient implements SubmissionClient {
  readonly receipts = new Map<HexString, SubmissionReceipt>();
  readonly pendingTransactions = new Set<HexString>();
  readonly simulatedBatches: Array<{
    entryPoint: HexString;
    operationCount: number;
    gas?: bigint;
  }> = [];
  readonly submittedTransactions: HexString[] = [];

  balance = 10n ** 18n;
  nextTransactionHash =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as HexString;
  balanceError: Error | null = null;
  simulationError: Error | null = null;
  receiptError: Error | null = null;
  transactionError: Error | null = null;

  async simulateHandleOps(
    entryPoint: HexString,
    operations: PackedUserOperation[],
    _beneficiary: HexString,
    gas?: bigint,
  ): Promise<{ request: unknown }> {
    if (this.simulationError) {
      throw this.simulationError;
    }

    this.simulatedBatches.push({
      entryPoint,
      operationCount: operations.length,
      gas,
    });

    return {
      request: {
        entryPoint,
        operations,
      },
    };
  }

  async submitHandleOps(request: unknown): Promise<HexString> {
    void request;
    this.submittedTransactions.push(this.nextTransactionHash);
    this.pendingTransactions.add(this.nextTransactionHash);
    return this.nextTransactionHash;
  }

  async getTransactionReceipt(hash: HexString): Promise<SubmissionReceipt | null> {
    if (this.receiptError) {
      throw this.receiptError;
    }

    const receipt = this.receipts.get(hash) ?? null;
    if (receipt) {
      this.pendingTransactions.delete(hash);
    }

    return receipt;
  }

  async getTransaction(hash: HexString): Promise<{ hash: HexString } | null> {
    if (this.transactionError) {
      throw this.transactionError;
    }

    return this.pendingTransactions.has(hash) ? { hash } : null;
  }

  async getBalance(address: HexString): Promise<bigint> {
    void address;
    if (this.balanceError) {
      throw this.balanceError;
    }

    return this.balance;
  }
}

class FakePersistence implements BundlerPersistence {
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
    void operation;
  }

  deleteFinalizedOperation(hash: string): void {
    void hash;
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
    return [];
  }

  pruneFinalizedOperations(maxEntries: number): string[] {
    void maxEntries;
    return [];
  }

  saveSenderReputation(
    sender: string,
    failures: number,
    windowStartedAt: number | null,
    throttledUntil: number | null,
    bannedUntil: number | null,
  ): void {
    void sender;
    void failures;
    void windowStartedAt;
    void throttledUntil;
    void bannedUntil;
  }

  deleteSenderReputation(sender: string): void {
    void sender;
  }

  loadSenderReputations(): Array<{
    sender: string;
    failures: number;
    windowStartedAt: number | null;
    throttledUntil: number | null;
    bannedUntil: number | null;
  }> {
    return [];
  }

  deleteExpiredSenderReputations(nowMs?: number): void {
    void nowMs;
  }
}

const makeUserOperationEventLog = (
  userOpHash: HexString,
  sender: HexString,
  {
    success,
    actualGasCost,
    actualGasUsed,
  }: {
    success: boolean;
    actualGasCost: bigint;
    actualGasUsed: bigint;
  },
) => ({
  address: ENTRY_POINT_V07,
  topics: encodeEventTopics({
    abi: ENTRY_POINT_ABI,
    eventName: "UserOperationEvent",
    args: {
      userOpHash,
      sender,
      paymaster: ZERO_ADDRESS,
    },
  }) as readonly HexString[],
  data: encodeAbiParameters(
    [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
    [1n, success, actualGasCost, actualGasUsed],
  ),
});

describe("BundlerSubmitter", () => {
  it("clears balance health errors after the RPC recovers", async () => {
    const client = new FakeSubmissionClient();
    client.balanceError = new Error("balance rpc unavailable");

    const service = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
    });
    const submitter = new BundlerSubmitter(service, {
      chainRpcUrl: "https://rpc.mainnet.taiko.xyz",
      privateKey: `0x${"1".repeat(64)}`,
      client,
      pollIntervalMs: 10,
    });

    await submitter.tick();
    expect(submitter.getHealth().status).toBe("degraded");
    expect(submitter.getHealth().lastError).toContain("balance rpc unavailable");

    client.balanceError = null;
    await submitter.tick();

    expect(submitter.getHealth().status).toBe("ok");
    expect(submitter.getHealth().lastError).toBeUndefined();
  });

  it("rejects invalid beneficiary addresses at construction time", () => {
    const service = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
    });

    expect(
      () =>
        new BundlerSubmitter(service, {
          chainRpcUrl: "https://rpc.mainnet.taiko.xyz",
          privateKey: `0x${"1".repeat(64)}`,
          beneficiaryAddress: "not-an-address" as HexString,
        }),
    ).toThrow("beneficiaryAddress must be a valid hex address");
  });

  it("submits a pending user operation and finalizes it from the receipt logs", async () => {
    const client = new FakeSubmissionClient();
    const service = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
    });
    const userOperation = buildUserOperation();
    const userOpHash = await service.sendUserOperation(userOperation, ENTRY_POINT_V07);
    const submitter = new BundlerSubmitter(service, {
      chainRpcUrl: "https://rpc.mainnet.taiko.xyz",
      privateKey: `0x${"1".repeat(64)}`,
      client,
      pollIntervalMs: 10,
      txTimeoutMs: 10,
    });

    await submitter.tick();

    expect(client.simulatedBatches).toHaveLength(1);
    expect(client.submittedTransactions).toEqual([client.nextTransactionHash]);
    expect(service.getSubmittingUserOperationsCount()).toBe(1);

    client.receipts.set(client.nextTransactionHash, {
      transactionHash: client.nextTransactionHash,
      blockNumber: 123n,
      blockHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      status: "success",
      effectiveGasPrice: 4n,
      logs: [
        makeUserOperationEventLog(userOpHash as HexString, userOperation.sender, {
          success: true,
          actualGasCost: 120n,
          actualGasUsed: 30n,
        }),
      ],
    });

    await submitter.tick();

    expect(service.getSubmittingUserOperationsCount()).toBe(0);
    const receipt = service.getUserOperationReceipt(userOpHash);
    expect(receipt?.success).toBe(true);
    expect(receipt?.actualGasCost).toBe("0x78");
    expect(receipt?.actualGasUsed).toBe("0x1e");
    expect(receipt?.receipt.transactionHash).toBe(client.nextTransactionHash);
    expect(receipt?.logs).toHaveLength(1);
    expect(receipt?.receipt.logs).toHaveLength(1);
    expect(service.getHealth().operationalMetrics).toMatchObject({
      userOpsAcceptedTotal: 1,
      userOpsIncludedTotal: 1,
      userOpsFailedTotal: 0,
      acceptanceToInclusionSuccessRate: 1,
      simulationFailureReasons: {},
      revertReasons: {},
    });
  });

  it("marks a single operation as failed when simulation fails", async () => {
    const client = new FakeSubmissionClient();
    client.simulationError = new Error("AA23 reverted");

    const service = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
    });
    const userOpHash = await service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V07);
    const submitter = new BundlerSubmitter(service, {
      chainRpcUrl: "https://rpc.mainnet.taiko.xyz",
      privateKey: `0x${"1".repeat(64)}`,
      client,
      pollIntervalMs: 10,
    });

    await submitter.tick();

    expect(service.getPendingUserOperationsCount()).toBe(0);
    expect(service.getSubmittingUserOperationsCount()).toBe(0);
    expect(service.getUserOperationReceipt(userOpHash)).toBeNull();
    expect(client.submittedTransactions).toHaveLength(0);
    expect(service.getHealth().operationalMetrics).toMatchObject({
      userOpsAcceptedTotal: 1,
      userOpsIncludedTotal: 0,
      userOpsFailedTotal: 1,
      acceptanceToInclusionSuccessRate: 0,
      simulationFailureReasons: { AA23_reverted: 1 },
    });
  });

  it("tracks mixed finalize outcomes from receipt events in operational metrics", async () => {
    const client = new FakeSubmissionClient();
    const service = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
    });
    const includedHash = await service.sendUserOperation(
      buildUserOperation({ nonce: "0x10" }),
      ENTRY_POINT_V07,
    );
    const failedHash = await service.sendUserOperation(
      buildUserOperation({ nonce: "0x11" }),
      ENTRY_POINT_V07,
    );
    const submitter = new BundlerSubmitter(service, {
      chainRpcUrl: "https://rpc.mainnet.taiko.xyz",
      privateKey: `0x${"1".repeat(64)}`,
      client,
      pollIntervalMs: 10,
      maxOperationsPerBundle: 2,
    });

    await submitter.tick();

    client.receipts.set(client.nextTransactionHash, {
      transactionHash: client.nextTransactionHash,
      blockHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      blockNumber: 124n,
      status: "success",
      effectiveGasPrice: 9n,
      logs: [
        makeUserOperationEventLog(includedHash as HexString, buildUserOperation().sender, {
          success: true,
          actualGasCost: 50n,
          actualGasUsed: 25n,
        }),
        makeUserOperationEventLog(failedHash as HexString, buildUserOperation().sender, {
          success: false,
          actualGasCost: 80n,
          actualGasUsed: 40n,
        }),
      ],
    });

    await submitter.tick();

    expect(service.getUserOperationReceipt(includedHash)?.success).toBe(true);
    expect(service.getUserOperationReceipt(failedHash)?.success).toBe(false);
    expect(service.getHealth().operationalMetrics).toMatchObject({
      userOpsAcceptedTotal: 2,
      userOpsIncludedTotal: 1,
      userOpsFailedTotal: 1,
      acceptanceToInclusionSuccessRate: 0.5,
      revertReasons: { execution_reverted: 1 },
    });
  });

  it("marks malformed operations as failed instead of crashing the submitter", async () => {
    const client = new FakeSubmissionClient();
    const persistence = new FakePersistence();
    const userOpHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    persistence.pendingOperations.set(userOpHash, {
      entryPoint: ENTRY_POINT_V07,
      userOperation: buildUserOperation({
        callGasLimit: undefined,
        verificationGasLimit: undefined,
        preVerificationGas: undefined,
      }),
      receivedAt: Date.now(),
      state: "pending",
      submissionTxHash: null,
      submissionStartedAt: null,
    });
    const service = new BundlerService(
      {
        chainId: 167000,
        entryPoints: [ENTRY_POINT_V07],
      },
      persistence,
    );
    const submitter = new BundlerSubmitter(service, {
      chainRpcUrl: "https://rpc.mainnet.taiko.xyz",
      privateKey: `0x${"1".repeat(64)}`,
      client,
      pollIntervalMs: 10,
    });

    await submitter.tick();

    expect(service.getPendingUserOperationsCount()).toBe(0);
    expect(service.getSubmittingUserOperationsCount()).toBe(0);
    expect(service.getUserOperationReceipt(userOpHash)).toBeNull();
    expect(client.submittedTransactions).toHaveLength(0);
    expect(submitter.getHealth().status).toBe("degraded");
  });

  it("releases stale unconfirmed transactions and requeues them for submission", async () => {
    const client = new FakeSubmissionClient();
    const service = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
    });
    const hash = await service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V07);
    const submitter = new BundlerSubmitter(service, {
      chainRpcUrl: "https://rpc.mainnet.taiko.xyz",
      privateKey: `0x${"1".repeat(64)}`,
      client,
      pollIntervalMs: 10,
      txTimeoutMs: 1,
    });

    await submitter.tick();
    client.pendingTransactions.clear();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await submitter.tick();

    expect(client.submittedTransactions).toHaveLength(2);
    expect(service.getPendingUserOperationsCount()).toBe(0);
    expect(service.getSubmittingUserOperationsCount()).toBe(1);
    expect(service.getUserOperationByHash(hash)?.transactionHash).toBeNull();
  });

  it("degrades health instead of throwing when recovery RPC calls fail", async () => {
    const client = new FakeSubmissionClient();
    client.receiptError = new Error("upstream temporarily unavailable");

    const service = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
    });
    const hash = await service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V07);
    const claim = service.claimPendingUserOperations(1);
    expect(claim?.userOperations[0]?.hash).toBe(hash);
    service.recordUserOperationsSubmissionTxHash([hash], client.nextTransactionHash);

    const submitter = new BundlerSubmitter(service, {
      chainRpcUrl: "https://rpc.mainnet.taiko.xyz",
      privateKey: `0x${"1".repeat(64)}`,
      client,
      pollIntervalMs: 5,
    });

    submitter.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    submitter.stop();

    expect(service.getSubmittingUserOperationsCount()).toBe(1);
    expect(submitter.getHealth().status).toBe("degraded");
    expect(submitter.getHealth().lastError).toContain("upstream temporarily unavailable");
  });

  it("does not requeue pre-existing submitting operations without a tx hash", async () => {
    const client = new FakeSubmissionClient();
    const persistence = new FakePersistence();
    const bootstrapService = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
    });
    const userOperation = buildUserOperation();
    const userOpHash = await bootstrapService.sendUserOperation(userOperation, ENTRY_POINT_V07);

    persistence.pendingOperations.set(userOpHash, {
      entryPoint: ENTRY_POINT_V07,
      userOperation,
      receivedAt: Date.now() - 5_000,
      state: "submitting",
      submissionTxHash: null,
      submissionStartedAt: Date.now() - 5_000,
    });

    const service = new BundlerService(
      {
        chainId: 167000,
        entryPoints: [ENTRY_POINT_V07],
      },
      persistence,
    );
    const submitter = new BundlerSubmitter(service, {
      chainRpcUrl: "https://rpc.mainnet.taiko.xyz",
      privateKey: `0x${"1".repeat(64)}`,
      client,
      pollIntervalMs: 10,
      txTimeoutMs: 1,
    });

    await submitter.tick();

    expect(client.submittedTransactions).toHaveLength(0);
    expect(service.getPendingUserOperationsCount()).toBe(0);
    expect(service.getSubmittingUserOperationsCount()).toBe(1);
    expect(submitter.getHealth().status).toBe("degraded");
    expect(submitter.getHealth().lastError).toContain(
      "refusing automatic requeue to avoid duplicate bundle submission",
    );
  });

  it("computes a high simulation gas limit for cold-start UserOps with initCode", async () => {
    const client = new FakeSubmissionClient();
    const service = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
    });
    const coldStartOp = buildUserOperation({
      initCode: `0x${"aa".repeat(40)}` as HexString,
      callGasLimit: "0xd6d8", // 55_000
      verificationGasLimit: "0x7a120", // 500_000
      preVerificationGas: "0x5208", // 21_000
      paymasterVerificationGasLimit: "0x30d40", // 200_000
      paymasterPostOpGasLimit: "0x13880", // 80_000
    });
    await service.sendUserOperation(coldStartOp, ENTRY_POINT_V07);

    const submitter = new BundlerSubmitter(service, {
      chainRpcUrl: "https://rpc.mainnet.taiko.xyz",
      privateKey: `0x${"1".repeat(64)}`,
      client,
      pollIntervalMs: 10,
    });

    await submitter.tick();

    expect(client.simulatedBatches).toHaveLength(1);
    const simulationGas = client.simulatedBatches[0].gas;
    expect(simulationGas).toBeDefined();
    // Sum = 55_000 + 500_000 + 21_000 + 200_000 + 80_000 = 856_000
    // 856_000 * 1.5 = 1_284_000
    expect(simulationGas).toBe(1_284_000n);
    expect(simulationGas).toBeGreaterThan(500_000n);
  });

  it("computes a moderate simulation gas limit for warm UserOps without initCode", async () => {
    const client = new FakeSubmissionClient();
    const service = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V07],
    });
    // Note: sendUserOperation fills in default paymasterVerificationGasLimit (200_000)
    // and paymasterPostOpGasLimit (80_000) when not explicitly provided
    const warmOp = buildUserOperation({
      initCode: "0x",
      callGasLimit: "0xd6d8", // 55_000
      verificationGasLimit: "0x186a0", // 100_000
      preVerificationGas: "0x5208", // 21_000
    });
    await service.sendUserOperation(warmOp, ENTRY_POINT_V07);

    const submitter = new BundlerSubmitter(service, {
      chainRpcUrl: "https://rpc.mainnet.taiko.xyz",
      privateKey: `0x${"1".repeat(64)}`,
      client,
      pollIntervalMs: 10,
    });

    await submitter.tick();

    expect(client.simulatedBatches).toHaveLength(1);
    const simulationGas = client.simulatedBatches[0].gas;
    expect(simulationGas).toBeDefined();
    // Sum = 55_000 + 100_000 + 21_000 + 200_000 (default) + 80_000 (default) = 456_000
    // 456_000 * 1.5 = 684_000
    expect(simulationGas).toBe(684_000n);
    // Still higher than the old hardcoded 500k limit
    expect(simulationGas).toBeGreaterThan(500_000n);
  });
});

describe("computeSimulationGasLimit", () => {
  it("sums all gas fields with 1.5x multiplier", () => {
    const result = computeSimulationGasLimit([
      buildUserOperation({
        callGasLimit: "0x10000", // 65_536
        verificationGasLimit: "0x10000", // 65_536
        preVerificationGas: "0x10000", // 65_536
        paymasterVerificationGasLimit: "0x10000", // 65_536
        paymasterPostOpGasLimit: "0x10000", // 65_536
      }),
    ]);

    // 65_536 * 5 = 327_680; 327_680 * 3 / 2 = 491_520
    expect(result).toBe(491_520n);
  });

  it("returns the default 1_500_000 when all gas fields are missing", () => {
    const result = computeSimulationGasLimit([
      buildUserOperation({
        callGasLimit: undefined,
        verificationGasLimit: undefined,
        preVerificationGas: undefined,
      }),
    ]);

    expect(result).toBe(1_500_000n);
  });

  it("returns the default 1_500_000 for an empty operations array", () => {
    const result = computeSimulationGasLimit([]);
    expect(result).toBe(1_500_000n);
  });

  it("handles cold-start UserOps with high gas limits", () => {
    const result = computeSimulationGasLimit([
      buildUserOperation({
        callGasLimit: "0xd6d8", // 55_000
        verificationGasLimit: "0x7a120", // 500_000
        preVerificationGas: "0x5208", // 21_000
        paymasterVerificationGasLimit: "0x30d40", // 200_000
        paymasterPostOpGasLimit: "0x13880", // 80_000
      }),
    ]);

    // 55_000 + 500_000 + 21_000 + 200_000 + 80_000 = 856_000
    // 856_000 * 3 / 2 = 1_284_000
    expect(result).toBe(1_284_000n);
    expect(result).toBeGreaterThan(750_000n);
  });

  it("aggregates gas across multiple UserOps in a bundle", () => {
    const result = computeSimulationGasLimit([
      buildUserOperation({
        callGasLimit: "0x10000", // 65_536
        verificationGasLimit: "0x10000", // 65_536
        preVerificationGas: "0x10000", // 65_536
      }),
      buildUserOperation({
        callGasLimit: "0x10000", // 65_536
        verificationGasLimit: "0x10000", // 65_536
        preVerificationGas: "0x10000", // 65_536
      }),
    ]);

    // 65_536 * 3 * 2 = 393_216; 393_216 * 3 / 2 = 589_824
    expect(result).toBe(589_824n);
  });
});
