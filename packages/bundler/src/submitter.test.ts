import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";

import { ENTRY_POINT_ABI, type PackedUserOperation } from "./entrypoint.js";
import {
  BundlerService,
  type BundlerPersistence,
  type HexString,
  type UserOperation,
} from "./index.js";
import { BundlerSubmitter, type SubmissionClient, type SubmissionReceipt } from "./submitter.js";

const ENTRY_POINT_V08 = "0x0000000071727de22e5e9d8baf0edac6f37da032";
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
  readonly simulatedBatches: Array<{ entryPoint: HexString; operationCount: number }> = [];
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
  ): Promise<{ request: unknown }> {
    if (this.simulationError) {
      throw this.simulationError;
    }

    this.simulatedBatches.push({
      entryPoint,
      operationCount: operations.length,
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

  saveSenderReputation(sender: string, failures: number, bannedUntil: number | null): void {
    void sender;
    void failures;
    void bannedUntil;
  }

  deleteSenderReputation(sender: string): void {
    void sender;
  }

  loadSenderReputations(): Array<{ sender: string; failures: number; bannedUntil: number | null }> {
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
  address: ENTRY_POINT_V08,
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
      entryPoints: [ENTRY_POINT_V08],
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
      entryPoints: [ENTRY_POINT_V08],
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
      entryPoints: [ENTRY_POINT_V08],
    });
    const userOperation = buildUserOperation();
    const userOpHash = service.sendUserOperation(userOperation, ENTRY_POINT_V08);
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
  });

  it("marks a single operation as failed when simulation fails", async () => {
    const client = new FakeSubmissionClient();
    client.simulationError = new Error("AA23 reverted");

    const service = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V08],
    });
    const userOpHash = service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V08);
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
  });

  it("marks malformed operations as failed instead of crashing the submitter", async () => {
    const client = new FakeSubmissionClient();
    const service = new BundlerService({
      chainId: 167000,
      entryPoints: [ENTRY_POINT_V08],
    });
    const userOpHash = service.sendUserOperation(
      buildUserOperation({
        callGasLimit: undefined,
        verificationGasLimit: undefined,
        preVerificationGas: undefined,
      }),
      ENTRY_POINT_V08,
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
      entryPoints: [ENTRY_POINT_V08],
    });
    const hash = service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V08);
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
      entryPoints: [ENTRY_POINT_V08],
    });
    const hash = service.sendUserOperation(buildUserOperation(), ENTRY_POINT_V08);
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
      entryPoints: [ENTRY_POINT_V08],
    });
    const userOperation = buildUserOperation();
    const userOpHash = bootstrapService.sendUserOperation(userOperation, ENTRY_POINT_V08);

    persistence.pendingOperations.set(userOpHash, {
      entryPoint: ENTRY_POINT_V08,
      userOperation,
      receivedAt: Date.now() - 5_000,
      state: "submitting",
      submissionTxHash: null,
      submissionStartedAt: Date.now() - 5_000,
    });

    const service = new BundlerService(
      {
        chainId: 167000,
        entryPoints: [ENTRY_POINT_V08],
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
});
