import { createPublicClient, createWalletClient, http, isAddress, toHex, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  ENTRY_POINT_ABI,
  collectUserOperationExecutions,
  extractBundlerErrorReason,
  hexToBigInt,
  packUserOperation,
} from "./entrypoint.js";
import { logEvent } from "./logger.js";

import type { HexString, UserOperation, UserOperationReceiptLog } from "./index.js";
import type { BundlerService, ClaimedUserOperation, ClaimedUserOperations } from "./index.js";

export interface SubmissionClient {
  simulateHandleOps(
    entryPoint: HexString,
    operations: ReturnType<typeof packUserOperation>[],
    beneficiary: HexString,
    gas?: bigint,
  ): Promise<{ request: unknown }>;
  submitHandleOps(request: unknown): Promise<HexString>;
  getTransactionReceipt(hash: HexString): Promise<SubmissionReceipt | null>;
  getTransaction(hash: HexString): Promise<{ hash: HexString } | null>;
  getBalance(address: HexString): Promise<bigint>;
}

export interface SubmissionReceipt {
  transactionHash: HexString;
  blockNumber: bigint;
  blockHash: HexString;
  status: "success" | "reverted";
  effectiveGasPrice?: bigint;
  logs: UserOperationReceiptLog[];
}

export interface BundlerSubmitterConfig {
  chainRpcUrl: string;
  privateKey: HexString;
  chain?: Chain;
  pollIntervalMs?: number;
  maxOperationsPerBundle?: number;
  maxInflightTransactions?: number;
  txTimeoutMs?: number;
  beneficiaryAddress?: HexString;
  client?: SubmissionClient;
}

export interface BundlerSubmitterHealth {
  enabled: boolean;
  status: "ok" | "degraded";
  submitterAddress?: string;
  beneficiaryAddress?: string;
  pollIntervalMs?: number;
  maxOperationsPerBundle?: number;
  maxInflightTransactions?: number;
  inflightTransactions?: number;
  lastKnownBalanceWei?: string;
  lastAttemptAt?: string;
  lastSubmissionAt?: string;
  lastConfirmedAt?: string;
  lastSubmissionTxHash?: string;
  lastError?: string;
  submittedTransactions?: number;
  confirmedTransactions?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_OPERATIONS_PER_BUNDLE = 1;
const DEFAULT_MAX_INFLIGHT_TRANSACTIONS = 1;
const DEFAULT_TX_TIMEOUT_MS = 180_000;
const DEFAULT_SIMULATION_GAS = 1_500_000n;
const SIMULATION_GAS_MULTIPLIER_NUM = 3n;
const SIMULATION_GAS_MULTIPLIER_DEN = 2n;

export const computeSimulationGasLimit = (userOperations: UserOperation[]): bigint => {
  let totalGas = 0n;

  for (const userOperation of userOperations) {
    const callGasLimit =
      userOperation.callGasLimit !== undefined ? hexToBigInt(userOperation.callGasLimit) : 0n;
    const verificationGasLimit =
      userOperation.verificationGasLimit !== undefined
        ? hexToBigInt(userOperation.verificationGasLimit)
        : 0n;
    const preVerificationGas =
      userOperation.preVerificationGas !== undefined
        ? hexToBigInt(userOperation.preVerificationGas)
        : 0n;
    const paymasterVerificationGasLimit =
      userOperation.paymasterVerificationGasLimit !== undefined
        ? hexToBigInt(userOperation.paymasterVerificationGasLimit)
        : 0n;
    const paymasterPostOpGasLimit =
      userOperation.paymasterPostOpGasLimit !== undefined
        ? hexToBigInt(userOperation.paymasterPostOpGasLimit)
        : 0n;

    totalGas +=
      callGasLimit +
      verificationGasLimit +
      preVerificationGas +
      paymasterVerificationGasLimit +
      paymasterPostOpGasLimit;
  }

  if (totalGas === 0n) {
    return DEFAULT_SIMULATION_GAS;
  }

  return (totalGas * SIMULATION_GAS_MULTIPLIER_NUM) / SIMULATION_GAS_MULTIPLIER_DEN;
};

const isNotFoundError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("not found") || message.includes("could not be found");
};

const toIsoString = (timestamp: number | null): string | undefined =>
  timestamp === null ? undefined : new Date(timestamp).toISOString();

const uniqueTransactionCount = (operations: ClaimedUserOperation[]): number =>
  new Set(
    operations.flatMap((operation) =>
      operation.submissionTxHash === null ? [] : [operation.submissionTxHash],
    ),
  ).size;

export class ViemSubmissionClient implements SubmissionClient {
  private readonly publicClient;
  private readonly walletClient;
  private readonly account;

  constructor(rpcUrl: string, privateKey: HexString, chain?: Chain) {
    this.account = privateKeyToAccount(privateKey);
    this.publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });
    this.walletClient = createWalletClient({
      chain,
      account: this.account,
      transport: http(rpcUrl),
    });
  }

  get address(): HexString {
    return this.account.address;
  }

  async simulateHandleOps(
    entryPoint: HexString,
    operations: ReturnType<typeof packUserOperation>[],
    beneficiary: HexString,
    gas?: bigint,
  ): Promise<{ request: unknown }> {
    const baseFee = await this.publicClient.getBlock().then((b) => b.baseFeePerGas ?? 10_000_000n);
    const maxPriorityFeePerGas = 1_000_000n;
    const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;

    return this.publicClient.simulateContract({
      account: this.account,
      address: entryPoint,
      abi: ENTRY_POINT_ABI,
      functionName: "handleOps",
      args: [operations, beneficiary],
      gas: gas ?? DEFAULT_SIMULATION_GAS,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
  }

  async submitHandleOps(request: unknown): Promise<HexString> {
    return (await this.walletClient.writeContract(request as never)) as HexString;
  }

  async getTransactionReceipt(hash: HexString): Promise<SubmissionReceipt | null> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({ hash });
      return {
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        status: receipt.status,
        effectiveGasPrice: receipt.effectiveGasPrice,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          data: log.data,
          topics: log.topics,
          blockHash: log.blockHash ?? undefined,
          blockNumber: log.blockNumber === null ? undefined : toHex(log.blockNumber),
          transactionHash: log.transactionHash ?? undefined,
          transactionIndex:
            log.transactionIndex === null || log.transactionIndex === undefined
              ? undefined
              : toHex(log.transactionIndex),
          logIndex:
            log.logIndex === null || log.logIndex === undefined ? undefined : toHex(log.logIndex),
          removed: log.removed,
        })),
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }

      throw error;
    }
  }

  async getTransaction(hash: HexString): Promise<{ hash: HexString } | null> {
    try {
      const transaction = await this.publicClient.getTransaction({ hash });
      return { hash: transaction.hash };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }

      throw error;
    }
  }

  async getBalance(address: HexString): Promise<bigint> {
    return this.publicClient.getBalance({ address });
  }
}

export class BundlerSubmitter {
  readonly submitterAddress: HexString;
  readonly beneficiaryAddress: HexString;

  private readonly client: SubmissionClient;
  private readonly pollIntervalMs: number;
  private readonly maxOperationsPerBundle: number;
  private readonly maxInflightTransactions: number;
  private readonly txTimeoutMs: number;
  private readonly processStartedAt = Date.now();

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private tickPromise: Promise<void> | null = null;

  private lastKnownBalance: bigint | null = null;
  private lastAttemptAt: number | null = null;
  private lastSubmissionAt: number | null = null;
  private lastConfirmedAt: number | null = null;
  private lastSubmissionTxHash: HexString | null = null;
  private lastError: string | null = null;
  private balanceError: string | null = null;
  private recoveryError: string | null = null;
  private submittedTransactions = 0;
  private confirmedTransactions = 0;

  constructor(
    private readonly service: BundlerService,
    config: BundlerSubmitterConfig,
  ) {
    const client =
      config.client ??
      new ViemSubmissionClient(config.chainRpcUrl, config.privateKey, config.chain);
    if (config.beneficiaryAddress !== undefined && !isAddress(config.beneficiaryAddress)) {
      throw new Error("beneficiaryAddress must be a valid hex address");
    }

    this.client = client;
    this.submitterAddress =
      client instanceof ViemSubmissionClient
        ? client.address
        : privateKeyToAccount(config.privateKey).address;
    this.beneficiaryAddress = config.beneficiaryAddress ?? this.submitterAddress;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxOperationsPerBundle =
      config.maxOperationsPerBundle ?? DEFAULT_MAX_OPERATIONS_PER_BUNDLE;
    this.maxInflightTransactions =
      config.maxInflightTransactions ?? DEFAULT_MAX_INFLIGHT_TRANSACTIONS;
    this.txTimeoutMs = config.txTimeoutMs ?? DEFAULT_TX_TIMEOUT_MS;
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    logEvent("info", "bundler.submitter_started", {
      submitterAddress: this.submitterAddress,
      beneficiaryAddress: this.beneficiaryAddress,
      pollIntervalMs: this.pollIntervalMs,
      maxOperationsPerBundle: this.maxOperationsPerBundle,
      maxInflightTransactions: this.maxInflightTransactions,
    });
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getHealth(): BundlerSubmitterHealth {
    const inflight = uniqueTransactionCount(this.service.getSubmittingUserOperations());
    const healthError = this.recoveryError ?? this.lastError ?? this.balanceError;

    return {
      enabled: true,
      status: healthError === null ? "ok" : "degraded",
      submitterAddress: this.submitterAddress,
      beneficiaryAddress: this.beneficiaryAddress,
      pollIntervalMs: this.pollIntervalMs,
      maxOperationsPerBundle: this.maxOperationsPerBundle,
      maxInflightTransactions: this.maxInflightTransactions,
      inflightTransactions: inflight,
      lastKnownBalanceWei: this.lastKnownBalance?.toString(),
      lastAttemptAt: toIsoString(this.lastAttemptAt),
      lastSubmissionAt: toIsoString(this.lastSubmissionAt),
      lastConfirmedAt: toIsoString(this.lastConfirmedAt),
      lastSubmissionTxHash: this.lastSubmissionTxHash ?? undefined,
      lastError: healthError ?? undefined,
      submittedTransactions: this.submittedTransactions,
      confirmedTransactions: this.confirmedTransactions,
    };
  }

  async tick(): Promise<void> {
    if (this.tickPromise !== null) {
      await this.tickPromise;
      return;
    }

    this.tickPromise = this.runTick()
      .catch((error) => {
        this.lastError = extractBundlerErrorReason(error);
        logEvent("error", "bundler.submitter_tick_failed", {
          error: this.lastError,
        });
      })
      .finally(() => {
        this.tickPromise = null;

        if (!this.running) {
          return;
        }

        this.timer = setTimeout(() => {
          void this.tick();
        }, this.pollIntervalMs);
      });

    await this.tickPromise;
  }

  private async runTick(): Promise<void> {
    await this.refreshBalance();
    await this.recoverSubmittedTransactions();

    if (
      uniqueTransactionCount(this.service.getSubmittingUserOperations()) >=
      this.maxInflightTransactions
    ) {
      return;
    }

    const claim = this.service.claimPendingUserOperations(this.maxOperationsPerBundle);
    if (!claim) {
      return;
    }

    await this.submitClaim(claim);
  }

  private async refreshBalance(): Promise<void> {
    try {
      this.lastKnownBalance = await this.client.getBalance(this.submitterAddress);
      this.balanceError = null;
    } catch (error) {
      this.balanceError = extractBundlerErrorReason(error);
      logEvent("warn", "bundler.submitter_balance_check_failed", {
        error: this.balanceError,
      });
    }
  }

  private async recoverSubmittedTransactions(): Promise<void> {
    const submittingOperations = this.service.getSubmittingUserOperations();
    if (submittingOperations.length === 0) {
      this.recoveryError = null;
      return;
    }

    const claimsWithoutTransaction = submittingOperations.filter(
      (operation) => operation.submissionTxHash === null,
    );
    const orphanedClaims = claimsWithoutTransaction.filter(
      (operation) =>
        operation.submissionStartedAt === null ||
        operation.submissionStartedAt < this.processStartedAt,
    );
    if (orphanedClaims.length > 0) {
      this.recoveryError =
        "Recovered submitting user operations without a recorded transaction hash; refusing automatic requeue to avoid duplicate bundle submission";
      logEvent("warn", "bundler.submitter_recovery_blocked_untracked_claims", {
        orphanedOperations: orphanedClaims.length,
        userOpHashes: orphanedClaims.map((operation) => operation.hash),
      });
    } else {
      this.recoveryError = null;
    }

    const staleUntrackedClaims = claimsWithoutTransaction.filter((operation) => {
      if (operation.submissionStartedAt === null) {
        return false;
      }

      if (operation.submissionStartedAt < this.processStartedAt) {
        return false;
      }

      return Date.now() - operation.submissionStartedAt >= this.txTimeoutMs;
    });
    if (staleUntrackedClaims.length > 0) {
      this.service.releaseUserOperations(staleUntrackedClaims.map((operation) => operation.hash));
      logEvent("warn", "bundler.submitter_released_untracked_claims", {
        releasedOperations: staleUntrackedClaims.length,
      });
    }

    const operationsByTransaction = new Map<HexString, ClaimedUserOperation[]>();
    for (const operation of submittingOperations) {
      if (operation.submissionTxHash === null) {
        continue;
      }

      const group = operationsByTransaction.get(operation.submissionTxHash) ?? [];
      group.push(operation);
      operationsByTransaction.set(operation.submissionTxHash, group);
    }

    for (const [transactionHash, operations] of operationsByTransaction.entries()) {
      const receipt = await this.client.getTransactionReceipt(transactionHash);
      if (receipt) {
        this.finalizeSubmittedTransaction(transactionHash, operations, receipt);
        continue;
      }

      const pendingTransaction = await this.client.getTransaction(transactionHash);
      if (pendingTransaction) {
        continue;
      }

      const oldestSubmissionAt = operations.reduce<number | null>((oldest, operation) => {
        if (operation.submissionStartedAt === null) {
          return oldest;
        }

        if (oldest === null || operation.submissionStartedAt < oldest) {
          return operation.submissionStartedAt;
        }

        return oldest;
      }, null);

      if (oldestSubmissionAt === null || Date.now() - oldestSubmissionAt < this.txTimeoutMs) {
        continue;
      }

      this.service.releaseUserOperations(operations.map((operation) => operation.hash));
      this.lastError = `submission transaction ${transactionHash} disappeared before confirmation`;
      logEvent("warn", "bundler.submission_released_stale_transaction", {
        transactionHash,
        releasedOperations: operations.length,
      });
    }
  }

  private async submitClaim(claim: ClaimedUserOperations): Promise<void> {
    this.lastAttemptAt = Date.now();

    const packableOperations: ClaimedUserOperation[] = [];
    const packedOperations: ReturnType<typeof packUserOperation>[] = [];
    for (const operation of claim.userOperations) {
      try {
        packedOperations.push(packUserOperation(operation.userOperation));
        packableOperations.push(operation);
      } catch (error) {
        const reason = extractBundlerErrorReason(error);
        this.service.markUserOperationFailed(operation.hash, reason);
        this.lastError = reason;
        logEvent("warn", "bundler.submission_packing_failed", {
          userOpHash: operation.hash,
          entryPoint: claim.entryPoint,
          reason,
        });
      }
    }

    if (packableOperations.length === 0) {
      return;
    }

    const activeClaim =
      packableOperations.length === claim.userOperations.length
        ? claim
        : {
            entryPoint: claim.entryPoint,
            userOperations: packableOperations,
          };
    const userOpHashes = activeClaim.userOperations.map((operation) => operation.hash);

    const simulationGas = computeSimulationGasLimit(
      activeClaim.userOperations.map((operation) => operation.userOperation),
    );

    let simulation: { request: unknown };
    try {
      simulation = await this.client.simulateHandleOps(
        activeClaim.entryPoint,
        packedOperations,
        this.beneficiaryAddress,
        simulationGas,
      );
    } catch (error) {
      const reason = extractBundlerErrorReason(error);

      if (activeClaim.userOperations.length === 1) {
        this.service.markUserOperationFailed(activeClaim.userOperations[0].hash, reason);
        this.lastError = reason;
        logEvent("warn", "bundler.submission_simulation_failed", {
          userOpHash: activeClaim.userOperations[0].hash,
          entryPoint: activeClaim.entryPoint,
          reason,
        });
        return;
      }

      logEvent("warn", "bundler.bundle_simulation_failed_fallback_single", {
        entryPoint: activeClaim.entryPoint,
        bundledOperations: activeClaim.userOperations.length,
        reason,
      });

      for (let index = 0; index < activeClaim.userOperations.length; index += 1) {
        if (
          uniqueTransactionCount(this.service.getSubmittingUserOperations()) >=
          this.maxInflightTransactions
        ) {
          this.service.releaseUserOperations(
            activeClaim.userOperations.slice(index).map((operation) => operation.hash),
          );
          return;
        }

        await this.submitClaim({
          entryPoint: activeClaim.entryPoint,
          userOperations: [activeClaim.userOperations[index]],
        });
      }

      return;
    }

    let transactionHash: HexString;
    try {
      transactionHash = await this.client.submitHandleOps(simulation.request);
    } catch (error) {
      const reason = extractBundlerErrorReason(error);
      this.service.releaseUserOperations(userOpHashes);
      this.lastError = reason;
      logEvent("warn", "bundler.submission_send_failed", {
        entryPoint: activeClaim.entryPoint,
        operationCount: activeClaim.userOperations.length,
        reason,
      });
      return;
    }

    this.service.recordUserOperationsSubmissionTxHash(userOpHashes, transactionHash);
    this.lastError = null;
    this.lastSubmissionAt = Date.now();
    this.lastSubmissionTxHash = transactionHash;
    this.submittedTransactions += 1;
    logEvent("info", "bundler.submission_sent", {
      transactionHash,
      entryPoint: activeClaim.entryPoint,
      operationCount: activeClaim.userOperations.length,
      userOpHashes,
    });

    const receipt = await this.client.getTransactionReceipt(transactionHash);
    if (receipt) {
      this.finalizeSubmittedTransaction(transactionHash, activeClaim.userOperations, receipt);
    }
  }

  private finalizeSubmittedTransaction(
    transactionHash: HexString,
    operations: ClaimedUserOperation[],
    receipt: SubmissionReceipt,
  ): void {
    const effectiveGasPrice =
      receipt.effectiveGasPrice === undefined ? "0x0" : toHex(receipt.effectiveGasPrice);

    if (receipt.status === "reverted") {
      for (const operation of operations) {
        this.service.finalizeUserOperation(operation.hash, {
          transactionHash,
          blockNumber: Number(receipt.blockNumber),
          blockHash: receipt.blockHash,
          gasUsed: "0x0",
          gasCost: "0x0",
          effectiveGasPrice,
          success: false,
          reason: "bundle_submission_reverted",
          logs: receipt.logs,
        });
      }

      this.lastError = `bundle transaction ${transactionHash} reverted`;
      logEvent("error", "bundler.submission_reverted", {
        transactionHash,
        operationCount: operations.length,
      });
      return;
    }

    const executions = collectUserOperationExecutions(operations[0].entryPoint, receipt.logs);
    for (const operation of operations) {
      const execution = executions.get(operation.hash);

      if (!execution) {
        this.service.finalizeUserOperation(operation.hash, {
          transactionHash,
          blockNumber: Number(receipt.blockNumber),
          blockHash: receipt.blockHash,
          gasUsed: "0x0",
          gasCost: "0x0",
          effectiveGasPrice,
          success: false,
          reason: "user_operation_event_missing",
          logs: receipt.logs,
        });
        continue;
      }

      this.service.finalizeUserOperation(operation.hash, {
        transactionHash,
        blockNumber: Number(receipt.blockNumber),
        blockHash: receipt.blockHash,
        gasUsed: toHex(execution.actualGasUsed),
        gasCost: toHex(execution.actualGasCost),
        effectiveGasPrice,
        success: execution.success,
        reason: execution.success ? undefined : (execution.revertReason ?? "execution_reverted"),
        logs: receipt.logs,
      });
    }

    this.lastError = null;
    this.lastConfirmedAt = Date.now();
    this.confirmedTransactions += 1;
    logEvent("info", "bundler.submission_confirmed", {
      transactionHash,
      blockNumber: receipt.blockNumber.toString(),
      operationCount: operations.length,
    });
  }
}
