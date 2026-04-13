import {
  ADDRESS_PATTERN,
  bigIntToHex,
  buildHealth,
  DEFAULT_TAIKO_RPC_URL,
  hexToBigInt,
  logEvent,
  makeJsonRpcError,
  makeJsonRpcResult,
  parsePositiveIntegerWithFallback,
  PRIVATE_KEY_PATTERN,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  RPC_RESOURCE_UNAVAILABLE,
  SERVO_SUPPORTED_ENTRY_POINTS,
  type HexString,
  type JsonRpcResponse,
} from "@agent-paymaster/shared";
import { serve } from "@hono/node-server";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Chain } from "viem";
import { taiko, taikoHoodi } from "viem/chains";
import { SenderReputationTracker } from "./reputation.js";

import { buildCanonicalUserOpHash } from "./entrypoint.js";
import { BundlerPersistenceStore } from "./persistence.js";
import {
  assertEntryPointSupported,
  BundlerRpcError,
  getBytesLength,
  normalizeAddress,
  parseBundleSubmission,
  parseEntryPoint,
  parseHashField,
  parseJsonRpcRequest,
  parsePositionalParams,
  parseSendUserOperationParams,
  parseUserOperation,
} from "./rpc-parsing.js";
import {
  buildAgeBucketCounts,
  incrementReasonCounter,
  reasonCountersToRecord,
  recordAgeBucket,
} from "./metrics.js";
import { ViemAdmissionSimulator, ViemCallGasEstimator, ViemGasSimulator } from "./simulators.js";
import { type BundlerSubmitterHealth, BundlerSubmitter } from "./submitter.js";
import type {
  AdmissionSimulator,
  CallGasEstimator,
  ClaimedUserOperation,
  ClaimedUserOperations,
  GasSimulator,
  UserOperation,
  UserOperationGasEstimate,
  UserOperationReceiptLog,
} from "./types.js";

export type { HexString } from "@agent-paymaster/shared";
export type {
  AdmissionSimulator,
  CallGasEstimator,
  ClaimedUserOperation,
  ClaimedUserOperations,
  GasSimulator,
  UserOperation,
  UserOperationGasEstimate,
  UserOperationReceiptLog,
} from "./types.js";

const REPUTATION_THROTTLE_FAILURES = 3;
const REPUTATION_BAN_FAILURES = 5;
const DEFAULT_REPUTATION_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_THROTTLE_WINDOW_MS = 10 * 1000;
const DEFAULT_SUPPORTED_ENTRY_POINTS: HexString[] = [...SERVO_SUPPORTED_ENTRY_POINTS];

export interface UserOperationLookupResult {
  userOperation: UserOperation;
  entryPoint: string;
  transactionHash: string | null;
  blockNumber: HexString | null;
  blockHash: HexString | null;
}

export interface UserOperationReceipt {
  userOpHash: string;
  sender: string;
  nonce: HexString;
  entryPoint: string;
  success: boolean;
  actualGasCost: HexString;
  actualGasUsed: HexString;
  reason: string | null;
  logs: UserOperationReceiptLog[];
  receipt: {
    transactionHash: string;
    blockNumber: HexString;
    blockHash: HexString;
    effectiveGasPrice: HexString;
    gasUsed: HexString;
    status: HexString;
    logs: UserOperationReceiptLog[];
  };
}

export interface BundlerBundle {
  bundleHash: string;
  entryPoint: string;
  userOperationHashes: string[];
}

interface StoredUserOperation {
  hash: string;
  userOperation: UserOperation;
  entryPoint: HexString;
  receivedAt: number;
  estimatedGasLimit: bigint | null;
  state: "pending" | "submitting" | "included" | "failed";
  bundleHash: string | null;
  submissionTxHash: HexString | null;
  submissionStartedAt: number | null;
  transactionHash: HexString | null;
  blockNumber: number | null;
  blockHash: HexString | null;
  reason: string | null;
  gasUsed: bigint | null;
  gasCost: bigint | null;
  effectiveGasPrice: bigint | null;
  receiptLogs: UserOperationReceiptLog[] | null;
  finalizedAt: number | null;
}

export interface BundlerMempoolDepth {
  pending: number;
  submitting: number;
  total: number;
}

export interface BundlerMempoolAgeMs {
  pendingOldest: number;
  submittingOldest: number;
}

export interface BundlerMempoolAgeDistribution {
  pending: Record<string, number>;
  submitting: Record<string, number>;
}

export interface BundlerOperationalMetrics {
  userOpsAcceptedTotal: number;
  userOpsIncludedTotal: number;
  userOpsFailedTotal: number;
  acceptanceToInclusionSuccessRate: number;
  averageAcceptanceToInclusionMs: number;
  simulationFailureReasons: Record<string, number>;
  revertReasons: Record<string, number>;
}

export interface BundlerPersistence {
  savePendingOperation(
    hash: string,
    entryPoint: HexString,
    userOperation: UserOperation,
    receivedAt: number,
  ): void;
  markPendingOperationSubmitting(hash: string, startedAt: number): void;
  recordPendingOperationsTransactionHash(hashes: string[], transactionHash: HexString): void;
  markPendingOperationPending(hash: string): void;
  removePendingOperation(hash: string): void;
  loadPendingOperations(): Array<{
    hash: string;
    entryPoint: HexString;
    userOperation: UserOperation;
    receivedAt: number;
    state: "pending" | "submitting";
    submissionTxHash: HexString | null;
    submissionStartedAt: number | null;
  }>;
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
  }): void;
  deleteFinalizedOperation(hash: string): void;
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
  }>;
  pruneFinalizedOperations(maxEntries: number): string[];
  saveSenderReputation(
    sender: string,
    failures: number,
    windowStartedAt: number | null,
    throttledUntil: number | null,
    bannedUntil: number | null,
  ): void;
  deleteSenderReputation(sender: string): void;
  loadSenderReputations(): Array<{
    sender: string;
    failures: number;
    windowStartedAt: number | null;
    throttledUntil: number | null;
    bannedUntil: number | null;
  }>;
  deleteExpiredSenderReputations(nowMs?: number): void;
}

interface BundlerConfigInput {
  chainId?: number;
  entryPoints?: string[];
  acceptUserOperations?: boolean;
  reputationBanFailures?: number;
  reputationThrottleFailures?: number;
  reputationWindowMs?: number;
  throttleWindowMs?: number;
  banWindowMs?: number;
  baseCallGas?: bigint;
  baseVerificationGas?: bigint;
  initCodeDeployGas?: bigint;
  basePreVerificationGas?: bigint;
  perByteCallDataGas?: bigint;
  perByteVerificationGas?: bigint;
  perBytePreVerificationGas?: bigint;
  l1DataGasScalar?: bigint;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
  maxFinalizedOperations?: number;
  gasSimulator?: GasSimulator;
  callGasEstimator?: CallGasEstimator;
  callGasBufferPercent?: bigint;
  callGasHeuristicMultiplier?: bigint;
  admissionSimulator?: AdmissionSimulator;
}

interface BundlerConfig {
  chainId: number;
  entryPoints: string[];
  acceptUserOperations: boolean;
  reputationBanFailures: number;
  reputationThrottleFailures: number;
  reputationWindowMs: number;
  throttleWindowMs: number;
  banWindowMs: number;
  baseCallGas: bigint;
  baseVerificationGas: bigint;
  initCodeDeployGas: bigint;
  basePreVerificationGas: bigint;
  perByteCallDataGas: bigint;
  perByteVerificationGas: bigint;
  perBytePreVerificationGas: bigint;
  l1DataGasScalar: bigint;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  callGasBufferPercent: bigint;
  callGasHeuristicMultiplier: bigint;
  maxFinalizedOperations: number;
}

const parseBigIntWithFallback = (value: string | undefined, fallback: bigint): bigint => {
  if (value === undefined) {
    return fallback;
  }

  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const resolveChainById = (chainId: number): Chain | undefined => {
  switch (chainId) {
    case 167000:
      return taiko;
    case 167013:
      return taikoHoodi;
    default:
      return undefined;
  }
};

export { ViemAdmissionSimulator, ViemCallGasEstimator, ViemGasSimulator } from "./simulators.js";

export class BundlerService {
  readonly config: BundlerConfig;

  private readonly userOperations = new Map<string, StoredUserOperation>();
  private readonly bundles = new Map<string, string[]>();
  private readonly reputation: SenderReputationTracker;
  private readonly persistence?: BundlerPersistence;
  private readonly gasSimulator?: GasSimulator;
  private readonly callGasEstimator?: CallGasEstimator;
  private readonly admissionSimulator?: AdmissionSimulator;
  private readonly simulationFailureReasons = new Map<string, number>();
  private readonly revertReasons = new Map<string, number>();
  private bundleSequence = 0;
  private userOpsAcceptedTotal = 0;
  private userOpsIncludedTotal = 0;
  private userOpsFailedTotal = 0;
  private inclusionLatencySampleCount = 0;
  private inclusionLatencyTotalMs = 0;

  constructor(config: BundlerConfigInput = {}, persistence?: BundlerPersistence) {
    this.config = {
      chainId: config.chainId ?? 167000,
      entryPoints:
        config.entryPoints?.map((entryPoint) => normalizeAddress(entryPoint)) ??
        DEFAULT_SUPPORTED_ENTRY_POINTS,
      acceptUserOperations: config.acceptUserOperations ?? true,
      reputationBanFailures: config.reputationBanFailures ?? REPUTATION_BAN_FAILURES,
      reputationThrottleFailures: config.reputationThrottleFailures ?? REPUTATION_THROTTLE_FAILURES,
      reputationWindowMs: config.reputationWindowMs ?? DEFAULT_REPUTATION_WINDOW_MS,
      throttleWindowMs: config.throttleWindowMs ?? DEFAULT_THROTTLE_WINDOW_MS,
      banWindowMs: config.banWindowMs ?? 2 * 60 * 1000,
      baseCallGas: config.baseCallGas ?? 55_000n,
      baseVerificationGas: config.baseVerificationGas ?? 120_000n,
      initCodeDeployGas: config.initCodeDeployGas ?? 500_000n,
      basePreVerificationGas: config.basePreVerificationGas ?? 21_000n,
      perByteCallDataGas: config.perByteCallDataGas ?? 16n,
      perByteVerificationGas: config.perByteVerificationGas ?? 4n,
      perBytePreVerificationGas: config.perBytePreVerificationGas ?? 4n,
      l1DataGasScalar: config.l1DataGasScalar ?? 1n,
      paymasterVerificationGasLimit: config.paymasterVerificationGasLimit ?? 200_000n,
      paymasterPostOpGasLimit: config.paymasterPostOpGasLimit ?? 80_000n,
      callGasBufferPercent: config.callGasBufferPercent ?? 15n,
      callGasHeuristicMultiplier: config.callGasHeuristicMultiplier ?? 3n,
      maxFinalizedOperations: config.maxFinalizedOperations ?? 10_000,
    };
    this.reputation = new SenderReputationTracker(this.config, persistence);
    this.gasSimulator = config.gasSimulator;
    this.callGasEstimator = config.callGasEstimator;
    this.admissionSimulator = config.admissionSimulator;

    this.persistence = persistence;

    if (persistence) {
      this.loadFromPersistence(persistence);
    }
  }

  private loadFromPersistence(persistence: BundlerPersistence): void {
    persistence.deleteExpiredSenderReputations();

    for (const entry of persistence.loadPendingOperations()) {
      const stored = this.createStoredOperation({
        hash: entry.hash,
        userOperation: entry.userOperation,
        entryPoint: entry.entryPoint,
        receivedAt: entry.receivedAt,
        state: entry.state,
        submissionTxHash: entry.submissionTxHash,
        submissionStartedAt: entry.submissionStartedAt,
      });
      stored.estimatedGasLimit = this.getDeclaredGasLimit(entry.userOperation);
      this.userOperations.set(entry.hash, stored);
    }

    for (const entry of persistence.loadFinalizedOperations()) {
      const stored = this.createStoredOperation({
        hash: entry.hash,
        userOperation: entry.userOperation,
        entryPoint: entry.entryPoint,
        receivedAt: entry.receivedAt,
        state: entry.state,
        transactionHash: entry.transactionHash,
        blockNumber: entry.blockNumber,
        blockHash: entry.blockHash,
        reason: entry.reason,
        gasUsed: entry.gasUsed,
        gasCost: entry.gasCost,
        effectiveGasPrice: entry.effectiveGasPrice,
        receiptLogs: entry.receiptLogs,
        finalizedAt: entry.finalizedAt,
      });
      stored.estimatedGasLimit = this.getDeclaredGasLimit(entry.userOperation);
      this.userOperations.set(entry.hash, stored);
    }

    for (const reputation of persistence.loadSenderReputations()) {
      this.reputation.load(reputation.sender, {
        failures: reputation.failures,
        windowStartedAt: reputation.windowStartedAt ?? Date.now(),
        throttledUntil: reputation.throttledUntil,
        bannedUntil: reputation.bannedUntil,
      });
    }

    this.enforceFinalizedRetention();
  }

  getHealth() {
    const now = Date.now();
    const mempoolDepth: BundlerMempoolDepth = {
      pending: 0,
      submitting: 0,
      total: 0,
    };
    const mempoolAgeMs: BundlerMempoolAgeMs = {
      pendingOldest: 0,
      submittingOldest: 0,
    };
    const mempoolAgeDistribution: BundlerMempoolAgeDistribution = {
      pending: buildAgeBucketCounts(),
      submitting: buildAgeBucketCounts(),
    };
    let finalized = 0;
    let bannedSenders = 0;

    for (const operation of this.userOperations.values()) {
      const ageMs = Math.max(0, now - operation.receivedAt);

      if (operation.state === "pending") {
        mempoolDepth.pending += 1;
        mempoolDepth.total += 1;
        mempoolAgeMs.pendingOldest = Math.max(mempoolAgeMs.pendingOldest, ageMs);
        recordAgeBucket(mempoolAgeDistribution.pending, ageMs);
        continue;
      }

      if (operation.state === "submitting") {
        mempoolDepth.submitting += 1;
        mempoolDepth.total += 1;
        mempoolAgeMs.submittingOldest = Math.max(mempoolAgeMs.submittingOldest, ageMs);
        recordAgeBucket(mempoolAgeDistribution.submitting, ageMs);
        continue;
      }

      if (operation.state === "included" || operation.state === "failed") {
        finalized += 1;
      }
    }

    bannedSenders = this.reputation.countBannedSenders(now);

    const acceptanceToInclusionSuccessRate =
      this.userOpsAcceptedTotal === 0 ? 0 : this.userOpsIncludedTotal / this.userOpsAcceptedTotal;
    const averageAcceptanceToInclusionMs =
      this.inclusionLatencySampleCount === 0
        ? 0
        : this.inclusionLatencyTotalMs / this.inclusionLatencySampleCount;

    const operationalMetrics: BundlerOperationalMetrics = {
      userOpsAcceptedTotal: this.userOpsAcceptedTotal,
      userOpsIncludedTotal: this.userOpsIncludedTotal,
      userOpsFailedTotal: this.userOpsFailedTotal,
      acceptanceToInclusionSuccessRate: Number(acceptanceToInclusionSuccessRate.toFixed(6)),
      averageAcceptanceToInclusionMs: Number(averageAcceptanceToInclusionMs.toFixed(3)),
      simulationFailureReasons: reasonCountersToRecord(this.simulationFailureReasons),
      revertReasons: reasonCountersToRecord(this.revertReasons),
    };

    return {
      ...buildHealth("bundler"),
      chainId: this.config.chainId,
      entryPoints: this.config.entryPoints,
      acceptsUserOperations: this.config.acceptUserOperations,
      pendingUserOperations: mempoolDepth.pending,
      submittingUserOperations: mempoolDepth.submitting,
      finalizedUserOperations: finalized,
      bannedSenders,
      mempoolDepth,
      mempoolAgeMs,
      mempoolAgeDistribution,
      operationalMetrics,
    };
  }

  getPendingUserOperationsCount(): number {
    let pending = 0;
    for (const operation of this.userOperations.values()) {
      if (operation.state === "pending") {
        pending += 1;
      }
    }

    return pending;
  }

  getSubmittingUserOperationsCount(): number {
    let submitting = 0;
    for (const operation of this.userOperations.values()) {
      if (operation.state === "submitting") {
        submitting += 1;
      }
    }

    return submitting;
  }

  getSubmittingUserOperations(): ClaimedUserOperation[] {
    return [...this.userOperations.values()]
      .filter((operation) => operation.state === "submitting")
      .sort((left, right) => left.receivedAt - right.receivedAt)
      .map((operation) => ({
        hash: operation.hash,
        userOperation: operation.userOperation,
        entryPoint: operation.entryPoint,
        receivedAt: operation.receivedAt,
        submissionTxHash: operation.submissionTxHash,
        submissionStartedAt: operation.submissionStartedAt,
      }));
  }

  getSupportedEntryPoints(): string[] {
    return [...this.config.entryPoints];
  }

  async estimateUserOperationGas(
    userOperationInput: unknown,
    entryPointInput: unknown,
  ): Promise<UserOperationGasEstimate> {
    const userOperation = parseUserOperation(userOperationInput, this.config.chainId);
    const entryPoint = parseEntryPoint(entryPointInput);

    assertEntryPointSupported(entryPoint, this.config.entryPoints);

    const callDataBytes = getBytesLength(userOperation.callData);
    const initCodeBytes = getBytesLength(userOperation.initCode);

    let callGasLimit =
      userOperation.callGasLimit !== undefined
        ? hexToBigInt(userOperation.callGasLimit)
        : this.config.baseCallGas + callDataBytes * this.config.perByteCallDataGas;

    const heuristicVerificationGas =
      this.config.baseVerificationGas +
      callDataBytes * this.config.perByteVerificationGas +
      initCodeBytes * 8n;

    // When initCode is present, factory deployment (CREATE2 + constructor)
    // dominates verification gas. Apply a floor to avoid OOG during deployment.
    const verificationFloor =
      initCodeBytes > 0n
        ? heuristicVerificationGas + this.config.initCodeDeployGas
        : heuristicVerificationGas;

    let verificationGasLimit =
      userOperation.verificationGasLimit !== undefined
        ? hexToBigInt(userOperation.verificationGasLimit)
        : verificationFloor;

    const taikoDataGas =
      userOperation.l1DataGas === undefined ? 0n : hexToBigInt(userOperation.l1DataGas);
    const preVerificationGas =
      userOperation.preVerificationGas !== undefined
        ? hexToBigInt(userOperation.preVerificationGas)
        : this.config.basePreVerificationGas +
          callDataBytes * this.config.perBytePreVerificationGas +
          taikoDataGas * this.config.l1DataGasScalar;

    const baseline: UserOperationGasEstimate = {
      callGasLimit: bigIntToHex(callGasLimit),
      verificationGasLimit: bigIntToHex(verificationGasLimit),
      preVerificationGas: bigIntToHex(preVerificationGas),
      paymasterVerificationGasLimit: bigIntToHex(this.config.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: bigIntToHex(this.config.paymasterPostOpGasLimit),
    };

    if (this.gasSimulator !== undefined) {
      try {
        const simulatedPreOpGas = await this.gasSimulator.estimatePreOpGas(
          userOperation,
          entryPoint,
          baseline,
        );
        if (simulatedPreOpGas > preVerificationGas) {
          const simulatedVerificationGas = simulatedPreOpGas - preVerificationGas;
          if (simulatedVerificationGas > verificationGasLimit) {
            verificationGasLimit = simulatedVerificationGas;
          }
        }
      } catch (error) {
        logEvent("warn", "bundler.gas_simulation_failed", {
          entryPoint,
          sender: userOperation.sender,
          reason: error instanceof Error ? error.message : "simulation_failed",
        });
      }
    }

    // Call gas estimation: replace heuristic with simulation when available
    if (this.callGasEstimator !== undefined && userOperation.callGasLimit === undefined) {
      try {
        const simulatedCallGas = await this.callGasEstimator.estimateCallGas(
          userOperation.sender,
          userOperation.callData,
          entryPoint,
        );
        if (simulatedCallGas !== null) {
          callGasLimit = simulatedCallGas;
        } else {
          // Estimation unavailable (undeployed account or empty callData) — scale heuristic
          callGasLimit = callGasLimit * this.config.callGasHeuristicMultiplier;
        }
      } catch (error) {
        logEvent("warn", "bundler.call_gas_estimator_error", {
          entryPoint,
          sender: userOperation.sender,
          reason: error instanceof Error ? error.message : "call_gas_estimation_error",
        });
        // Estimator threw unexpectedly — scale heuristic as fallback
        callGasLimit = callGasLimit * this.config.callGasHeuristicMultiplier;
      }
    }

    return {
      callGasLimit: bigIntToHex(callGasLimit),
      verificationGasLimit: bigIntToHex(verificationGasLimit),
      preVerificationGas: bigIntToHex(preVerificationGas),
      paymasterVerificationGasLimit: bigIntToHex(this.config.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: bigIntToHex(this.config.paymasterPostOpGasLimit),
    };
  }

  private async prepareUserOperationForAdmission(
    userOperation: UserOperation,
    entryPoint: HexString,
  ): Promise<UserOperation> {
    const estimate = await this.estimateUserOperationGas(userOperation, entryPoint);
    return {
      ...userOperation,
      callGasLimit: userOperation.callGasLimit ?? estimate.callGasLimit,
      verificationGasLimit: userOperation.verificationGasLimit ?? estimate.verificationGasLimit,
      preVerificationGas: userOperation.preVerificationGas ?? estimate.preVerificationGas,
      paymasterVerificationGasLimit:
        userOperation.paymasterVerificationGasLimit ?? estimate.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit:
        userOperation.paymasterPostOpGasLimit ?? estimate.paymasterPostOpGasLimit,
      paymasterAndData: userOperation.paymasterAndData ?? "0x",
    };
  }

  async sendUserOperation(userOperationInput: unknown, entryPointInput: unknown): Promise<string> {
    if (!this.config.acceptUserOperations) {
      throw new BundlerRpcError(
        RPC_RESOURCE_UNAVAILABLE,
        "Automatic submission is disabled for this bundler",
        {
          reason: "submission_disabled",
        },
      );
    }

    const parsed = parseSendUserOperationParams(
      { userOperation: userOperationInput, entryPoint: entryPointInput },
      this.config.chainId,
    );

    const preparedUserOperation = await this.prepareUserOperationForAdmission(
      parsed.userOperation,
      parsed.entryPoint,
    );

    this.reputation.ensureCanSubmit(preparedUserOperation.sender);
    assertEntryPointSupported(parsed.entryPoint, this.config.entryPoints);

    const userOpHash = buildCanonicalUserOpHash(
      preparedUserOperation,
      parsed.entryPoint,
      this.config.chainId,
    );
    const matchingPendingOperation = this.findOpenOperationBySenderAndNonce(
      preparedUserOperation.sender,
      hexToBigInt(preparedUserOperation.nonce),
    );

    if (matchingPendingOperation && matchingPendingOperation.hash !== userOpHash) {
      throw new BundlerRpcError(
        RPC_RESOURCE_UNAVAILABLE,
        "Conflicting pending operation for sender and nonce",
        {
          reason: "nonce_conflict",
          sender: preparedUserOperation.sender,
          nonce: preparedUserOperation.nonce,
          conflictingUserOpHash: matchingPendingOperation.hash,
        },
      );
    }

    const existingOperation = this.userOperations.get(userOpHash);
    if (existingOperation) {
      if (existingOperation.state === "failed") {
        this.requeueFailedOperation(existingOperation, parsed.userOperation);
      }
      return userOpHash;
    }

    if (this.admissionSimulator) {
      try {
        await this.admissionSimulator.simulateValidation(preparedUserOperation, parsed.entryPoint);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "validation_failed";
        this.reputation.recordDeterministicFailure(preparedUserOperation.sender);
        throw new BundlerRpcError(
          RPC_INVALID_PARAMS,
          `UserOperation validation failed: ${reason}`,
          {
            reason: "validation_failed",
            sender: preparedUserOperation.sender,
            entryPoint: parsed.entryPoint,
            details: reason,
          },
        );
      }
    }

    const receivedAt = Date.now();
    const stored = this.createStoredOperation({
      hash: userOpHash,
      userOperation: preparedUserOperation,
      entryPoint: parsed.entryPoint,
      receivedAt,
      state: "pending",
    });
    stored.estimatedGasLimit = this.getDeclaredGasLimit(preparedUserOperation);
    this.userOperations.set(userOpHash, stored);

    this.persistence?.savePendingOperation(
      userOpHash,
      parsed.entryPoint,
      preparedUserOperation,
      receivedAt,
    );
    this.userOpsAcceptedTotal += 1;

    return userOpHash;
  }

  getUserOperationByHash(userOpHashInput: unknown): UserOperationLookupResult | null {
    const userOpHash = parseHashField(userOpHashInput, "userOpHash");
    const operation = this.userOperations.get(userOpHash);
    if (!operation) {
      return null;
    }

    return {
      userOperation: operation.userOperation,
      entryPoint: operation.entryPoint,
      transactionHash: operation.transactionHash,
      blockNumber:
        operation.blockNumber === null ? null : bigIntToHex(BigInt(operation.blockNumber)),
      blockHash: operation.blockHash,
    };
  }

  getUserOperationReceipt(userOpHashInput: unknown): UserOperationReceipt | null {
    const userOpHash = parseHashField(userOpHashInput, "userOpHash");
    const operation = this.userOperations.get(userOpHash);

    if (
      !operation ||
      operation.state === "pending" ||
      operation.state === "submitting" ||
      operation.transactionHash === null ||
      operation.blockNumber === null ||
      operation.blockHash === null
    ) {
      return null;
    }

    const gasUsed = operation.gasUsed ?? 0n;
    const gasCost = operation.gasCost ?? 0n;
    const receiptLogs = operation.receiptLogs ?? [];

    return {
      userOpHash: operation.hash,
      sender: operation.userOperation.sender,
      nonce: operation.userOperation.nonce,
      entryPoint: operation.entryPoint,
      success: operation.state === "included",
      actualGasCost: bigIntToHex(gasCost),
      actualGasUsed: bigIntToHex(gasUsed),
      reason: operation.reason,
      logs: receiptLogs,
      receipt: {
        transactionHash: operation.transactionHash,
        blockNumber: bigIntToHex(BigInt(operation.blockNumber)),
        blockHash: operation.blockHash,
        effectiveGasPrice:
          operation.effectiveGasPrice === null
            ? operation.userOperation.maxFeePerGas
            : bigIntToHex(operation.effectiveGasPrice),
        gasUsed: bigIntToHex(gasUsed),
        status: operation.state === "included" ? "0x1" : "0x0",
        logs: receiptLogs,
      },
    };
  }

  claimPendingUserOperations(maxOperations = 10): ClaimedUserOperations | null {
    if (!Number.isInteger(maxOperations) || maxOperations <= 0) {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "maxOperations must be a positive integer", {
        reason: "bundle_size_invalid",
      });
    }

    const candidates = [...this.userOperations.values()]
      .filter((operation) => operation.state === "pending")
      .sort((left, right) => left.receivedAt - right.receivedAt);

    if (candidates.length === 0) {
      return null;
    }

    const entryPoint = candidates[0].entryPoint;
    const selected = candidates
      .filter((operation) => operation.entryPoint === entryPoint)
      .slice(0, maxOperations);

    const submissionStartedAt = Date.now();
    for (const operation of selected) {
      operation.state = "submitting";
      operation.bundleHash = null;
      operation.reason = null;
      operation.submissionTxHash = null;
      operation.submissionStartedAt = submissionStartedAt;
      this.persistence?.markPendingOperationSubmitting(operation.hash, submissionStartedAt);
    }

    return {
      entryPoint,
      userOperations: selected.map((operation) => ({
        hash: operation.hash,
        userOperation: operation.userOperation,
        entryPoint: operation.entryPoint,
        receivedAt: operation.receivedAt,
        submissionTxHash: operation.submissionTxHash,
        submissionStartedAt: operation.submissionStartedAt,
      })),
    };
  }

  releaseUserOperations(userOpHashesInput: unknown[]): void {
    for (const input of userOpHashesInput) {
      const userOpHash = parseHashField(input, "userOpHash");
      const operation = this.userOperations.get(userOpHash);
      if (!operation || operation.state !== "submitting") {
        continue;
      }

      operation.state = "pending";
      operation.bundleHash = null;
      operation.reason = null;
      operation.submissionTxHash = null;
      operation.submissionStartedAt = null;
      this.persistence?.markPendingOperationPending(userOpHash);
    }
  }

  recordUserOperationsSubmissionTxHash(
    userOpHashesInput: unknown[],
    transactionHashInput: unknown,
  ): void {
    const transactionHash = parseHashField(transactionHashInput, "transactionHash") as HexString;
    const userOpHashes: string[] = [];

    for (const input of userOpHashesInput) {
      const userOpHash = parseHashField(input, "userOpHash");
      const operation = this.userOperations.get(userOpHash);
      if (!operation || operation.state !== "submitting") {
        continue;
      }

      operation.reason = null;
      operation.submissionTxHash = transactionHash;
      operation.submissionStartedAt ??= Date.now();
      userOpHashes.push(userOpHash);
    }

    if (userOpHashes.length > 0) {
      this.persistence?.recordPendingOperationsTransactionHash(userOpHashes, transactionHash);
    }
  }

  finalizeUserOperation(userOpHashInput: unknown, submissionInput: unknown): void {
    const userOpHash = parseHashField(userOpHashInput, "userOpHash");
    const operation = this.userOperations.get(userOpHash);

    if (!operation) {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "Unknown user operation hash", {
        reason: "userop_not_found",
      });
    }

    const submission = parseBundleSubmission(submissionInput);
    const gasUsed = hexToBigInt(submission.gasUsed);
    const gasCost = hexToBigInt(submission.gasCost);
    const gasPrice = submission.effectiveGasPrice
      ? hexToBigInt(submission.effectiveGasPrice)
      : gasUsed === 0n
        ? hexToBigInt(operation.userOperation.maxFeePerGas)
        : gasCost / gasUsed;
    const finalizationLatencyMs = Math.max(0, Date.now() - operation.receivedAt);

    operation.state = submission.success ? "included" : "failed";
    operation.bundleHash = null;
    operation.submissionTxHash = null;
    operation.submissionStartedAt = null;
    operation.transactionHash = submission.transactionHash;
    operation.blockNumber = submission.blockNumber;
    operation.blockHash = submission.blockHash;
    operation.reason = submission.success
      ? null
      : (submission.reason ?? submission.revertReason ?? "execution_reverted");
    operation.gasUsed = gasUsed;
    operation.gasCost = gasCost;
    operation.effectiveGasPrice = gasPrice;
    operation.receiptLogs = submission.logs ?? null;
    operation.finalizedAt = Date.now();

    if (operation.estimatedGasLimit !== null && operation.estimatedGasLimit > 0n) {
      const deltaGas = gasUsed - operation.estimatedGasLimit;
      // Negative drift means we over-estimated gas; positive means we under-estimated.
      const driftBps = Number((deltaGas * 10_000n) / operation.estimatedGasLimit);
      logEvent("info", "bundler.gas_estimate_drift", {
        userOpHash: operation.hash,
        sender: operation.userOperation.sender,
        entryPoint: operation.entryPoint,
        estimatedGasLimit: operation.estimatedGasLimit.toString(),
        actualGasUsed: gasUsed.toString(),
        driftGas: deltaGas.toString(),
        driftBps,
      });
    }

    if (submission.success) {
      this.userOpsIncludedTotal += 1;
      this.inclusionLatencySampleCount += 1;
      this.inclusionLatencyTotalMs += finalizationLatencyMs;
      this.reputation.clear(operation.userOperation.sender);
    } else {
      this.userOpsFailedTotal += 1;
      incrementReasonCounter(
        this.revertReasons,
        operation.reason ?? submission.reason ?? submission.revertReason ?? "execution_reverted",
      );
    }

    this.persistFinalizedOperation(operation);
    this.persistence?.removePendingOperation(userOpHash);
    this.enforceFinalizedRetention();
  }

  createBundle(maxOperations = 10): BundlerBundle | null {
    const claim = this.claimPendingUserOperations(maxOperations);
    if (!claim) {
      return null;
    }

    const userOperationHashes = claim.userOperations.map((operation) => operation.hash);
    const sequence = this.bundleSequence;
    this.bundleSequence += 1;
    const bundleHash = `0x${createHash("sha256")
      .update(`${sequence}:${userOperationHashes.join(":")}`)
      .digest("hex")}`;

    for (const operation of claim.userOperations) {
      const stored = this.userOperations.get(operation.hash);
      if (!stored) {
        continue;
      }

      stored.bundleHash = bundleHash;
    }

    this.bundles.set(bundleHash, userOperationHashes);

    return { bundleHash, entryPoint: claim.entryPoint, userOperationHashes };
  }

  markBundleSubmitted(bundleHashInput: unknown, submissionInput: unknown): void {
    const bundleHash = parseHashField(bundleHashInput, "bundleHash");
    const operationHashes = this.bundles.get(bundleHash);

    if (!operationHashes) {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "Unknown bundle hash", {
        reason: "bundle_not_found",
      });
    }

    for (const userOpHash of operationHashes) {
      this.finalizeUserOperation(userOpHash, submissionInput);
    }

    this.bundles.delete(bundleHash);
  }

  markUserOperationFailed(userOpHashInput: unknown, reason = "simulation_failed"): void {
    const userOpHash = parseHashField(userOpHashInput, "userOpHash");
    const operation = this.userOperations.get(userOpHash);

    if (!operation) {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "Unknown user operation hash", {
        reason: "userop_not_found",
      });
    }

    operation.state = "failed";
    operation.bundleHash = null;
    operation.submissionTxHash = null;
    operation.submissionStartedAt = null;
    operation.transactionHash = null;
    operation.blockNumber = null;
    operation.blockHash = null;
    operation.reason = reason;
    operation.gasUsed = null;
    operation.gasCost = null;
    operation.effectiveGasPrice = null;
    operation.receiptLogs = null;
    operation.finalizedAt = Date.now();
    this.userOpsFailedTotal += 1;
    incrementReasonCounter(this.simulationFailureReasons, reason);
    this.reputation.recordDeterministicFailure(operation.userOperation.sender);
    this.persistFinalizedOperation(operation);
    this.persistence?.removePendingOperation(userOpHash);
    this.enforceFinalizedRetention();
  }

  private createStoredOperation({
    hash,
    userOperation,
    entryPoint,
    receivedAt,
    state,
    submissionTxHash = null,
    submissionStartedAt = null,
    transactionHash = null,
    blockNumber = null,
    blockHash = null,
    reason = null,
    gasUsed = null,
    gasCost = null,
    effectiveGasPrice = null,
    receiptLogs = null,
    finalizedAt = null,
  }: {
    hash: string;
    userOperation: UserOperation;
    entryPoint: HexString;
    receivedAt: number;
    state: "pending" | "submitting" | "included" | "failed";
    submissionTxHash?: HexString | null;
    submissionStartedAt?: number | null;
    transactionHash?: HexString | null;
    blockNumber?: number | null;
    blockHash?: HexString | null;
    reason?: string | null;
    gasUsed?: bigint | null;
    gasCost?: bigint | null;
    effectiveGasPrice?: bigint | null;
    receiptLogs?: UserOperationReceiptLog[] | null;
    finalizedAt?: number | null;
  }): StoredUserOperation {
    return {
      hash,
      userOperation,
      entryPoint,
      receivedAt,
      estimatedGasLimit: null,
      state,
      bundleHash: null,
      submissionTxHash,
      submissionStartedAt,
      transactionHash,
      blockNumber,
      blockHash,
      reason,
      gasUsed,
      gasCost,
      effectiveGasPrice,
      receiptLogs,
      finalizedAt,
    };
  }

  private requeueFailedOperation(
    operation: StoredUserOperation,
    userOperation: UserOperation,
  ): void {
    const receivedAt = Date.now();

    operation.userOperation = userOperation;
    operation.receivedAt = receivedAt;
    operation.state = "pending";
    operation.bundleHash = null;
    operation.submissionTxHash = null;
    operation.submissionStartedAt = null;
    operation.transactionHash = null;
    operation.blockNumber = null;
    operation.blockHash = null;
    operation.reason = null;
    operation.gasUsed = null;
    operation.gasCost = null;
    operation.effectiveGasPrice = null;
    operation.receiptLogs = null;
    operation.finalizedAt = null;

    this.persistence?.deleteFinalizedOperation(operation.hash);
    this.persistence?.savePendingOperation(
      operation.hash,
      operation.entryPoint,
      operation.userOperation,
      receivedAt,
    );
  }

  private persistFinalizedOperation(operation: StoredUserOperation): void {
    if (!this.persistence || operation.finalizedAt === null) {
      return;
    }

    this.persistence.saveFinalizedOperation({
      hash: operation.hash,
      entryPoint: operation.entryPoint,
      userOperation: operation.userOperation,
      receivedAt: operation.receivedAt,
      state: operation.state === "included" ? "included" : "failed",
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

  private enforceFinalizedRetention(): void {
    const limit = this.config.maxFinalizedOperations;
    if (!Number.isInteger(limit) || limit <= 0) {
      return;
    }

    if (this.persistence) {
      const deletedHashes = this.persistence.pruneFinalizedOperations(limit);
      for (const hash of deletedHashes) {
        const operation = this.userOperations.get(hash);
        if (operation && (operation.state === "included" || operation.state === "failed")) {
          this.userOperations.delete(hash);
        }
      }
      return;
    }

    const finalized = [...this.userOperations.values()]
      .filter(
        (operation): operation is StoredUserOperation & { finalizedAt: number } =>
          (operation.state === "included" || operation.state === "failed") &&
          operation.finalizedAt !== null,
      )
      .sort((left, right) => left.finalizedAt - right.finalizedAt);

    const pruneCount = finalized.length - limit;
    if (pruneCount <= 0) {
      return;
    }

    for (const operation of finalized.slice(0, pruneCount)) {
      this.userOperations.delete(operation.hash);
    }
  }

  async handleJsonRpc(payload: unknown): Promise<JsonRpcResponse> {
    const parsed = parseJsonRpcRequest(payload);

    if (!parsed.ok) {
      return makeJsonRpcError(parsed.id, parsed.code, parsed.message, parsed.data);
    }

    const request = parsed.request;

    try {
      switch (request.method) {
        case "eth_supportedEntryPoints": {
          return makeJsonRpcResult(request.id, this.getSupportedEntryPoints());
        }
        case "eth_estimateUserOperationGas": {
          const [userOperation, entryPoint] = parsePositionalParams(
            request.method,
            request.params,
            2,
          );
          const result = await this.estimateUserOperationGas(userOperation, entryPoint);
          return makeJsonRpcResult(request.id, result);
        }
        case "eth_sendUserOperation": {
          const [userOperation, entryPoint] = parsePositionalParams(
            request.method,
            request.params,
            2,
          );
          const hash = await this.sendUserOperation(userOperation, entryPoint);
          return makeJsonRpcResult(request.id, hash);
        }
        case "eth_getUserOperationByHash": {
          const [userOpHash] = parsePositionalParams(request.method, request.params, 1);
          return makeJsonRpcResult(request.id, this.getUserOperationByHash(userOpHash));
        }
        case "eth_getUserOperationReceipt": {
          const [userOpHash] = parsePositionalParams(request.method, request.params, 1);
          return makeJsonRpcResult(request.id, this.getUserOperationReceipt(userOpHash));
        }
        default:
          return makeJsonRpcError(request.id, RPC_METHOD_NOT_FOUND, "Method not found", {
            method: request.method,
          });
      }
    } catch (error) {
      if (error instanceof BundlerRpcError) {
        return makeJsonRpcError(request.id, error.code, error.message, error.data);
      }

      return makeJsonRpcError(request.id, RPC_INTERNAL_ERROR, "Internal error", {
        reason: "unhandled_exception",
      });
    }
  }

  private findOpenOperationBySenderAndNonce(
    sender: string,
    nonce: bigint,
  ): StoredUserOperation | null {
    for (const operation of this.userOperations.values()) {
      if (operation.state !== "pending" && operation.state !== "submitting") {
        continue;
      }

      if (operation.userOperation.sender !== sender) {
        continue;
      }

      if (hexToBigInt(operation.userOperation.nonce) === nonce) {
        return operation;
      }
    }

    return null;
  }

  private getDeclaredGasLimit(userOperation: UserOperation): bigint | null {
    if (
      userOperation.callGasLimit === undefined ||
      userOperation.verificationGasLimit === undefined ||
      userOperation.preVerificationGas === undefined
    ) {
      return null;
    }

    const paymasterVerificationGasLimit =
      userOperation.paymasterVerificationGasLimit === undefined
        ? this.config.paymasterVerificationGasLimit
        : hexToBigInt(userOperation.paymasterVerificationGasLimit);
    const paymasterPostOpGasLimit =
      userOperation.paymasterPostOpGasLimit === undefined
        ? this.config.paymasterPostOpGasLimit
        : hexToBigInt(userOperation.paymasterPostOpGasLimit);

    return (
      hexToBigInt(userOperation.callGasLimit) +
      hexToBigInt(userOperation.verificationGasLimit) +
      hexToBigInt(userOperation.preVerificationGas) +
      paymasterVerificationGasLimit +
      paymasterPostOpGasLimit
    );
  }
}

export interface BundlerHealthMonitor {
  getHealth(): BundlerSubmitterHealth;
}

export interface CreateBundlerAppOptions {
  submitter?: BundlerHealthMonitor | null;
}

export const createBundlerApp = (
  service = new BundlerService(),
  options: CreateBundlerAppOptions = {},
): Hono => {
  const app = new Hono();

  app.get("/health", (c) => {
    const serviceHealth = service.getHealth();
    const submitterHealth = options.submitter?.getHealth();
    const status =
      submitterHealth && submitterHealth.status !== "ok" ? "degraded" : serviceHealth.status;

    return c.json({
      ...serviceHealth,
      status,
      ...(submitterHealth ? { submitter: submitterHealth } : {}),
    });
  });

  app.post("/rpc", async (c) => {
    let payload: unknown;

    try {
      payload = await c.req.json();
    } catch {
      return c.json(makeJsonRpcError(null, RPC_PARSE_ERROR, "Parse error"), 400);
    }

    const response = await service.handleJsonRpc(payload);
    return c.json(response, 200);
  });

  return app;
};

if (process.env.NODE_ENV !== "test") {
  const persistence = new BundlerPersistenceStore();
  const submitterPrivateKey = process.env.BUNDLER_SUBMITTER_PRIVATE_KEY?.trim();
  const beneficiaryAddress = process.env.BUNDLER_BENEFICIARY_ADDRESS?.trim();
  if (submitterPrivateKey !== undefined && !PRIVATE_KEY_PATTERN.test(submitterPrivateKey)) {
    throw new Error("BUNDLER_SUBMITTER_PRIVATE_KEY must be a 32-byte hex private key");
  }
  if (beneficiaryAddress !== undefined && !ADDRESS_PATTERN.test(beneficiaryAddress)) {
    throw new Error("BUNDLER_BENEFICIARY_ADDRESS must be a 20-byte hex address");
  }

  const submissionEnabled = submitterPrivateKey !== undefined;
  const chainId = parsePositiveIntegerWithFallback(process.env.BUNDLER_CHAIN_ID, 167000);
  const chain = resolveChainById(chainId);
  const chainRpcUrl =
    process.env.BUNDLER_CHAIN_RPC_URL?.trim() ||
    process.env.TAIKO_RPC_URL?.trim() ||
    process.env.TAIKO_MAINNET_RPC_URL?.trim() ||
    DEFAULT_TAIKO_RPC_URL;
  const service = new BundlerService(
    {
      chainId,
      acceptUserOperations: submissionEnabled,
      maxFinalizedOperations: parsePositiveIntegerWithFallback(
        process.env.BUNDLER_MAX_FINALIZED_OPERATIONS,
        10_000,
      ),
      gasSimulator: new ViemGasSimulator(chainRpcUrl, chain),
      callGasEstimator: new ViemCallGasEstimator(
        chainRpcUrl,
        chain,
        parseBigIntWithFallback(process.env.BUNDLER_CALL_GAS_BUFFER_PERCENT, 15n),
      ),
      admissionSimulator: submissionEnabled
        ? new ViemAdmissionSimulator(chainRpcUrl, chain)
        : undefined,
    },
    persistence,
  );

  const submitterMonitor: BundlerHealthMonitor = submissionEnabled
    ? new BundlerSubmitter(service, {
        privateKey: submitterPrivateKey as HexString,
        chain,
        chainRpcUrl,
        pollIntervalMs: parsePositiveIntegerWithFallback(
          process.env.BUNDLER_BUNDLE_POLL_INTERVAL_MS,
          5_000,
        ),
        maxOperationsPerBundle: parsePositiveIntegerWithFallback(
          process.env.BUNDLER_MAX_OPERATIONS_PER_BUNDLE,
          1,
        ),
        maxInflightTransactions: parsePositiveIntegerWithFallback(
          process.env.BUNDLER_MAX_INFLIGHT_TRANSACTIONS,
          1,
        ),
        txTimeoutMs: parsePositiveIntegerWithFallback(process.env.BUNDLER_TX_TIMEOUT_MS, 180_000),
        beneficiaryAddress: beneficiaryAddress as HexString | undefined,
      })
    : {
        getHealth: () => ({
          enabled: false,
          status: "degraded",
          lastError:
            "BUNDLER_SUBMITTER_PRIVATE_KEY is not configured; eth_sendUserOperation is disabled",
        }),
      };

  const app = createBundlerApp(service, {
    submitter: submitterMonitor,
  });
  const port = Number.parseInt(process.env.BUNDLER_PORT ?? "3001", 10);

  if (submitterMonitor instanceof BundlerSubmitter) {
    submitterMonitor.start();
  } else {
    logEvent("warn", "bundler.submitter_disabled", {
      reason: "BUNDLER_SUBMITTER_PRIVATE_KEY is not configured",
    });
  }

  serve({
    fetch: app.fetch,
    port,
  });

  logEvent("info", "bundler.rpc_listening", { port });
}
