import {
  buildHealth,
  normalizePaymasterAndData,
  SERVO_SUPPORTED_ENTRY_POINTS,
} from "@agent-paymaster/shared";
import { serve } from "@hono/node-server";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { createPublicClient, http, type Chain } from "viem";
import { taiko, taikoHekla, taikoHoodi } from "viem/chains";

import {
  buildCanonicalUserOpHash,
  ENTRY_POINT_SIMULATION_ABI,
  classifySimulationValidation,
  extractSimulationPreOpGas,
  packUserOperation,
} from "./entrypoint.js";
import { logEvent } from "./logger.js";
import { BundlerPersistenceStore } from "./persistence.js";
import { type BundlerSubmitterHealth, BundlerSubmitter } from "./submitter.js";

export type HexString = `0x${string}`;
export type JsonRpcId = string | number | null;

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;
const PRIVATE_KEY_PATTERN = /^0x[a-fA-F0-9]{64}$/;

const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;
const RPC_RESOURCE_UNAVAILABLE = -32001;

const REPUTATION_THROTTLE_FAILURES = 3;
const REPUTATION_BAN_FAILURES = 5;
const DEFAULT_REPUTATION_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_THROTTLE_WINDOW_MS = 10 * 1000;
const CANONICAL_TAIKO_ENTRY_POINT_V08 =
  "0x0000000071727de22e5e9d8baf0edac6f37da032" as HexString;
const DEFAULT_SUPPORTED_ENTRY_POINTS: HexString[] = Array.isArray(SERVO_SUPPORTED_ENTRY_POINTS)
  ? [...SERVO_SUPPORTED_ENTRY_POINTS]
  : [CANONICAL_TAIKO_ENTRY_POINT_V08];

export interface UserOperation {
  sender: HexString;
  nonce: HexString;
  initCode: HexString;
  callData: HexString;
  callGasLimit?: HexString;
  verificationGasLimit?: HexString;
  preVerificationGas?: HexString;
  paymasterVerificationGasLimit?: HexString;
  paymasterPostOpGasLimit?: HexString;
  maxFeePerGas: HexString;
  maxPriorityFeePerGas: HexString;
  paymasterAndData?: HexString;
  signature: HexString;
  l1DataGas?: HexString;
}

export interface UserOperationGasEstimate {
  callGasLimit: HexString;
  verificationGasLimit: HexString;
  preVerificationGas: HexString;
  paymasterVerificationGasLimit: HexString;
  paymasterPostOpGasLimit: HexString;
}

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
  receipt: {
    transactionHash: string;
    blockNumber: HexString;
    blockHash: HexString;
    effectiveGasPrice: HexString;
    gasUsed: HexString;
    status: HexString;
  };
}

export interface BundlerBundle {
  bundleHash: string;
  entryPoint: string;
  userOperationHashes: string[];
}

export interface ClaimedUserOperation {
  hash: string;
  userOperation: UserOperation;
  entryPoint: HexString;
  receivedAt: number;
  submissionTxHash: HexString | null;
  submissionStartedAt: number | null;
}

export interface ClaimedUserOperations {
  entryPoint: HexString;
  userOperations: ClaimedUserOperation[];
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcError;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

interface SenderReputation {
  failures: number;
  windowStartedAt: number | null;
  throttledUntil: number | null;
  bannedUntil: number | null;
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

interface BundlerRpcErrorData {
  method?: string;
  reason?: string;
  [key: string]: unknown;
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
  basePreVerificationGas?: bigint;
  perByteCallDataGas?: bigint;
  perByteVerificationGas?: bigint;
  perBytePreVerificationGas?: bigint;
  l1DataGasScalar?: bigint;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
  maxFinalizedOperations?: number;
  gasSimulator?: GasSimulator;
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
  basePreVerificationGas: bigint;
  perByteCallDataGas: bigint;
  perByteVerificationGas: bigint;
  perBytePreVerificationGas: bigint;
  l1DataGasScalar: bigint;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  maxFinalizedOperations: number;
}

export interface GasSimulator {
  estimatePreOpGas(
    userOperation: UserOperation,
    entryPoint: HexString,
    baseline: UserOperationGasEstimate,
  ): Promise<bigint>;
}

export interface AdmissionSimulator {
  simulateValidation(userOperation: UserOperation, entryPoint: HexString): Promise<void>;
}

interface SendUserOperationParamsInput {
  userOperation: unknown;
  entryPoint: unknown;
}

interface ParsedSendUserOperationParams {
  userOperation: UserOperation;
  entryPoint: HexString;
}

interface BundleSubmission {
  transactionHash: HexString;
  blockNumber: number;
  blockHash: HexString;
  gasUsed: HexString;
  gasCost: HexString;
  effectiveGasPrice?: HexString;
  success?: boolean;
  reason?: string;
  revertReason?: string;
}

const MEMPOOL_AGE_BUCKETS_MS = [30_000, 60_000, 300_000, 900_000] as const;

const buildAgeBucketKeys = (): string[] => [
  ...MEMPOOL_AGE_BUCKETS_MS.map((bucket) => `le_${bucket}ms`),
  `gt_${MEMPOOL_AGE_BUCKETS_MS[MEMPOOL_AGE_BUCKETS_MS.length - 1]}ms`,
];

const buildAgeBucketCounts = (): Record<string, number> =>
  Object.fromEntries(buildAgeBucketKeys().map((key) => [key, 0]));

const recordAgeBucket = (buckets: Record<string, number>, ageMs: number): void => {
  for (const bucket of MEMPOOL_AGE_BUCKETS_MS) {
    if (ageMs <= bucket) {
      buckets[`le_${bucket}ms`] += 1;
      return;
    }
  }

  buckets[`gt_${MEMPOOL_AGE_BUCKETS_MS[MEMPOOL_AGE_BUCKETS_MS.length - 1]}ms`] += 1;
};

const incrementReasonCounter = (counters: Map<string, number>, reason: string): void => {
  const normalized = reason.trim().replaceAll(/\s+/g, "_").slice(0, 120) || "unknown";
  counters.set(normalized, (counters.get(normalized) ?? 0) + 1);
};

const reasonCountersToRecord = (counters: Map<string, number>): Record<string, number> =>
  Object.fromEntries([...counters.entries()].sort(([left], [right]) => left.localeCompare(right)));

class BundlerRpcError extends Error {
  readonly code: number;
  readonly data?: BundlerRpcErrorData;

  constructor(code: number, message: string, data?: BundlerRpcErrorData) {
    super(message);
    this.name = "BundlerRpcError";
    this.code = code;
    this.data = data;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isJsonRpcId = (value: unknown): value is JsonRpcId =>
  typeof value === "string" || typeof value === "number" || value === null;

const normalizeHex = (value: string): HexString => {
  if (!HEX_PATTERN.test(value)) {
    throw new BundlerRpcError(RPC_INVALID_PARAMS, "Expected a hex string", {
      reason: "hex_required",
    });
  }

  return value.toLowerCase() as HexString;
};

const hexToBigInt = (value: string): bigint => {
  const normalized = normalizeHex(value);
  if (normalized === "0x") {
    return 0n;
  }

  return BigInt(normalized);
};

const bigIntToHex = (value: bigint): HexString => {
  if (value < 0n) {
    throw new Error("Negative bigint cannot be encoded as hex quantity");
  }

  return `0x${value.toString(16)}`;
};

const normalizeAddress = (value: string): HexString => {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new BundlerRpcError(RPC_INVALID_PARAMS, "Expected a valid address", {
      reason: "address_invalid",
    });
  }

  return value.toLowerCase() as HexString;
};

const getBytesLength = (hexValue: string): bigint => {
  const normalized = normalizeHex(hexValue);
  const payload = normalized.slice(2);

  if (payload.length % 2 !== 0) {
    throw new BundlerRpcError(RPC_INVALID_PARAMS, "Hex values must have even length", {
      reason: "hex_length_invalid",
    });
  }

  return BigInt(payload.length / 2);
};

const makeJsonRpcError = (
  id: JsonRpcId,
  code: number,
  message: string,
  data?: BundlerRpcErrorData,
): JsonRpcFailure => ({
  jsonrpc: "2.0",
  id,
  error: data ? { code, message, data } : { code, message },
});

const makeJsonRpcResult = <T>(id: JsonRpcId, result: T): JsonRpcSuccess<T> => ({
  jsonrpc: "2.0",
  id,
  result,
});

const parseHexField = (value: unknown, fieldName: string, optional = false): HexString => {
  if (value === undefined || value === null) {
    if (optional) {
      return "0x";
    }

    throw new BundlerRpcError(RPC_INVALID_PARAMS, `Missing required field: ${fieldName}`, {
      reason: "field_missing",
      field: fieldName,
    });
  }

  if (typeof value !== "string") {
    throw new BundlerRpcError(RPC_INVALID_PARAMS, `Field ${fieldName} must be a hex string`, {
      reason: "field_invalid_type",
      field: fieldName,
    });
  }

  return normalizeHex(value);
};

const parsePositiveIntegerWithFallback = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
};

const resolveChainById = (chainId: number): Chain | undefined => {
  switch (chainId) {
    case 167000:
      return taiko;
    case 167009:
      return taikoHekla;
    case 167013:
      return taikoHoodi;
    default:
      return undefined;
  }
};

export class ViemGasSimulator implements GasSimulator {
  private readonly publicClient;

  constructor(rpcUrl: string, chain?: Chain) {
    this.publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });
  }

  async estimatePreOpGas(
    userOperation: UserOperation,
    entryPoint: HexString,
    baseline: UserOperationGasEstimate,
  ): Promise<bigint> {
    const simulationUserOperation: UserOperation = {
      ...userOperation,
      callGasLimit: baseline.callGasLimit,
      verificationGasLimit: baseline.verificationGasLimit,
      preVerificationGas: baseline.preVerificationGas,
      paymasterVerificationGasLimit: baseline.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: baseline.paymasterPostOpGasLimit,
      paymasterAndData: userOperation.paymasterAndData ?? "0x",
    };

    try {
      await this.publicClient.simulateContract({
        address: entryPoint,
        abi: ENTRY_POINT_SIMULATION_ABI,
        functionName: "simulateValidation",
        args: [packUserOperation(simulationUserOperation)],
      });
    } catch (error) {
      const preOpGas = extractSimulationPreOpGas(error);
      if (preOpGas !== null) {
        return preOpGas;
      }

      throw error;
    }

    throw new Error("simulateValidation unexpectedly succeeded without revert");
  }
}

export class ViemAdmissionSimulator implements AdmissionSimulator {
  private readonly publicClient;

  constructor(rpcUrl: string, chain?: Chain) {
    this.publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });
  }

  async simulateValidation(userOperation: UserOperation, entryPoint: HexString): Promise<void> {
    try {
      await this.publicClient.simulateContract({
        address: entryPoint,
        abi: ENTRY_POINT_SIMULATION_ABI,
        functionName: "simulateValidation",
        args: [packUserOperation(userOperation)],
      });
    } catch (error) {
      const classified = classifySimulationValidation(error);
      if (classified?.success) {
        return;
      }

      if (classified && !classified.success) {
        throw new Error(classified.reason);
      }

      throw error;
    }

    throw new Error("simulateValidation unexpectedly succeeded without revert");
  }
}

export class BundlerService {
  readonly config: BundlerConfig;

  private readonly userOperations = new Map<string, StoredUserOperation>();
  private readonly bundles = new Map<string, string[]>();
  private readonly senderReputation = new Map<string, SenderReputation>();
  private readonly persistence?: BundlerPersistence;
  private readonly gasSimulator?: GasSimulator;
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
      basePreVerificationGas: config.basePreVerificationGas ?? 21_000n,
      perByteCallDataGas: config.perByteCallDataGas ?? 16n,
      perByteVerificationGas: config.perByteVerificationGas ?? 4n,
      perBytePreVerificationGas: config.perBytePreVerificationGas ?? 4n,
      l1DataGasScalar: config.l1DataGasScalar ?? 1n,
      paymasterVerificationGasLimit: config.paymasterVerificationGasLimit ?? 120_000n,
      paymasterPostOpGasLimit: config.paymasterPostOpGasLimit ?? 80_000n,
      maxFinalizedOperations: config.maxFinalizedOperations ?? 10_000,
    };
    this.gasSimulator = config.gasSimulator;
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
          finalizedAt: entry.finalizedAt,
        });
      stored.estimatedGasLimit = this.getDeclaredGasLimit(entry.userOperation);
      this.userOperations.set(entry.hash, stored);
    }

    for (const reputation of persistence.loadSenderReputations()) {
      this.senderReputation.set(reputation.sender, {
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

    for (const reputation of this.senderReputation.values()) {
      if (reputation.bannedUntil !== null && reputation.bannedUntil > now) {
        bannedSenders += 1;
      }
    }

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
    const userOperation = this.parseUserOperation(userOperationInput);
    const entryPoint = this.parseEntryPoint(entryPointInput);

    this.assertEntryPointSupported(entryPoint);

    const callDataBytes = getBytesLength(userOperation.callData);
    const initCodeBytes = getBytesLength(userOperation.initCode);

    const callGasLimit =
      userOperation.callGasLimit !== undefined
        ? hexToBigInt(userOperation.callGasLimit)
        : this.config.baseCallGas + callDataBytes * this.config.perByteCallDataGas;

    let verificationGasLimit =
      userOperation.verificationGasLimit !== undefined
        ? hexToBigInt(userOperation.verificationGasLimit)
        : this.config.baseVerificationGas +
          callDataBytes * this.config.perByteVerificationGas +
          initCodeBytes * 8n;

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

    const parsed = this.parseSendUserOperationParams({
      userOperation: userOperationInput,
      entryPoint: entryPointInput,
    });

    const preparedUserOperation = await this.prepareUserOperationForAdmission(
      parsed.userOperation,
      parsed.entryPoint,
    );

    this.ensureSenderCanSubmit(preparedUserOperation.sender);
    this.assertEntryPointSupported(parsed.entryPoint);

    const userOpHash = this.buildUserOpHash(preparedUserOperation, parsed.entryPoint);
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
        this.recordDeterministicValidationFailure(preparedUserOperation.sender);
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
    const userOpHash = this.parseUserOpHash(userOpHashInput);
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
    const userOpHash = this.parseUserOpHash(userOpHashInput);
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

    return {
      userOpHash: operation.hash,
      sender: operation.userOperation.sender,
      nonce: operation.userOperation.nonce,
      entryPoint: operation.entryPoint,
      success: operation.state === "included",
      actualGasCost: bigIntToHex(gasCost),
      actualGasUsed: bigIntToHex(gasUsed),
      reason: operation.reason,
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
      const userOpHash = this.parseUserOpHash(input);
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
    const transactionHash = this.parseHash(transactionHashInput, "transactionHash") as HexString;
    const userOpHashes: string[] = [];

    for (const input of userOpHashesInput) {
      const userOpHash = this.parseUserOpHash(input);
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
    const userOpHash = this.parseUserOpHash(userOpHashInput);
    const operation = this.userOperations.get(userOpHash);

    if (!operation) {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "Unknown user operation hash", {
        reason: "userop_not_found",
      });
    }

    const submission = this.parseBundleSubmission(submissionInput);
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
      this.clearSenderReputation(operation.userOperation.sender);
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
    const bundleHash = this.buildDeterministicHash(`${sequence}:${userOperationHashes.join(":")}`);

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
    const bundleHash = this.parseHash(bundleHashInput, "bundleHash");
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
    const userOpHash = this.parseUserOpHash(userOpHashInput);
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
    operation.finalizedAt = Date.now();
    this.userOpsFailedTotal += 1;
    incrementReasonCounter(this.simulationFailureReasons, reason);
    this.recordDeterministicValidationFailure(operation.userOperation.sender);
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
    const parsed = this.parseJsonRpcRequest(payload);

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
          const [userOperation, entryPoint] = this.parsePositionalParams(
            request.method,
            request.params,
            2,
          );
          const result = await this.estimateUserOperationGas(userOperation, entryPoint);
          return makeJsonRpcResult(request.id, result);
        }
        case "eth_sendUserOperation": {
          const [userOperation, entryPoint] = this.parsePositionalParams(
            request.method,
            request.params,
            2,
          );
          const hash = await this.sendUserOperation(userOperation, entryPoint);
          return makeJsonRpcResult(request.id, hash);
        }
        case "eth_getUserOperationByHash": {
          const [userOpHash] = this.parsePositionalParams(request.method, request.params, 1);
          return makeJsonRpcResult(request.id, this.getUserOperationByHash(userOpHash));
        }
        case "eth_getUserOperationReceipt": {
          const [userOpHash] = this.parsePositionalParams(request.method, request.params, 1);
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

  private parseJsonRpcRequest(
    payload: unknown,
  ):
    | { ok: true; request: JsonRpcRequest }
    | { ok: false; id: JsonRpcId; code: number; message: string; data?: BundlerRpcErrorData } {
    if (!isObject(payload)) {
      return {
        ok: false,
        id: null,
        code: RPC_INVALID_REQUEST,
        message: "Invalid Request",
        data: { reason: "payload_not_object" },
      };
    }

    const id: JsonRpcId = isJsonRpcId(payload.id) ? payload.id : null;

    if (payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
      return {
        ok: false,
        id,
        code: RPC_INVALID_REQUEST,
        message: "Invalid Request",
        data: { reason: "jsonrpc_shape_invalid" },
      };
    }

    return {
      ok: true,
      request: {
        jsonrpc: "2.0",
        id,
        method: payload.method,
        params: payload.params,
      },
    };
  }

  private parsePositionalParams(method: string, params: unknown, expectedCount: number): unknown[] {
    if (!Array.isArray(params)) {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "Method params must be an array", {
        reason: "params_not_array",
        method,
      });
    }

    if (params.length < expectedCount) {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "Missing required positional params", {
        reason: "params_missing",
        method,
        expectedCount,
      });
    }

    return params;
  }

  private parseSendUserOperationParams(
    input: SendUserOperationParamsInput,
  ): ParsedSendUserOperationParams {
    return {
      userOperation: this.parseUserOperation(input.userOperation),
      entryPoint: this.parseEntryPoint(input.entryPoint),
    };
  }

  private parseEntryPoint(entryPointInput: unknown): HexString {
    if (typeof entryPointInput !== "string") {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "entryPoint must be a string", {
        reason: "entrypoint_invalid_type",
      });
    }

    return normalizeAddress(entryPointInput);
  }

  private parseOptionalChainId(chainIdInput: unknown): number | null {
    if (chainIdInput === undefined || chainIdInput === null) {
      return null;
    }

    if (typeof chainIdInput === "number" && Number.isInteger(chainIdInput) && chainIdInput >= 0) {
      return chainIdInput;
    }

    if (typeof chainIdInput === "bigint" && chainIdInput >= 0n) {
      return Number(chainIdInput);
    }

    if (typeof chainIdInput === "string") {
      const trimmed = chainIdInput.trim();
      if (trimmed.length === 0) {
        throw new BundlerRpcError(RPC_INVALID_PARAMS, "userOperation.chainId must not be empty", {
          reason: "chain_id_invalid",
        });
      }

      const parsed =
        trimmed.startsWith("0x") || trimmed.startsWith("0X")
          ? Number.parseInt(trimmed, 16)
          : Number.parseInt(trimmed, 10);
      if (Number.isInteger(parsed) && parsed >= 0) {
        return parsed;
      }
    }

    throw new BundlerRpcError(RPC_INVALID_PARAMS, "userOperation.chainId must be an integer", {
      reason: "chain_id_invalid",
    });
  }

  private parseUserOperation(userOperationInput: unknown): UserOperation {
    if (!isObject(userOperationInput)) {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "userOperation must be an object", {
        reason: "userop_not_object",
      });
    }

    if (typeof userOperationInput.sender !== "string") {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "userOperation.sender is required", {
        reason: "sender_missing",
      });
    }

    const sender = normalizeAddress(userOperationInput.sender);
    const chainId = this.parseOptionalChainId(userOperationInput.chainId);
    if (chainId !== null && chainId !== this.config.chainId) {
      throw new BundlerRpcError(
        RPC_INVALID_PARAMS,
        `userOperation.chainId must match bundler chainId (${this.config.chainId})`,
        {
          reason: "chain_id_mismatch",
          expectedChainId: this.config.chainId,
          submittedChainId: chainId,
        },
      );
    }

    const userOperation: UserOperation = {
      sender,
      nonce: parseHexField(userOperationInput.nonce, "nonce"),
      initCode: parseHexField(userOperationInput.initCode, "initCode"),
      callData: parseHexField(userOperationInput.callData, "callData"),
      maxFeePerGas: parseHexField(userOperationInput.maxFeePerGas, "maxFeePerGas"),
      maxPriorityFeePerGas: parseHexField(
        userOperationInput.maxPriorityFeePerGas,
        "maxPriorityFeePerGas",
      ),
      signature: parseHexField(userOperationInput.signature, "signature"),
    };

    if (userOperation.signature === "0x") {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "userOperation.signature must not be empty", {
        reason: "signature_empty",
      });
    }

    if (userOperationInput.callGasLimit !== undefined) {
      userOperation.callGasLimit = parseHexField(userOperationInput.callGasLimit, "callGasLimit");
    }

    if (userOperationInput.verificationGasLimit !== undefined) {
      userOperation.verificationGasLimit = parseHexField(
        userOperationInput.verificationGasLimit,
        "verificationGasLimit",
      );
    }

    if (userOperationInput.preVerificationGas !== undefined) {
      userOperation.preVerificationGas = parseHexField(
        userOperationInput.preVerificationGas,
        "preVerificationGas",
      );
    }

    if (userOperationInput.paymasterVerificationGasLimit !== undefined) {
      userOperation.paymasterVerificationGasLimit = parseHexField(
        userOperationInput.paymasterVerificationGasLimit,
        "paymasterVerificationGasLimit",
      );
    }

    if (userOperationInput.paymasterPostOpGasLimit !== undefined) {
      userOperation.paymasterPostOpGasLimit = parseHexField(
        userOperationInput.paymasterPostOpGasLimit,
        "paymasterPostOpGasLimit",
      );
    }

    if (userOperationInput.paymasterAndData !== undefined) {
      userOperation.paymasterAndData = parseHexField(
        userOperationInput.paymasterAndData,
        "paymasterAndData",
      );

      if (userOperation.paymasterAndData !== "0x" && userOperation.paymasterAndData.length < 42) {
        throw new BundlerRpcError(
          RPC_INVALID_PARAMS,
          "paymasterAndData must include a paymaster address prefix",
          {
            reason: "paymaster_data_too_short",
          },
        );
      }
    }

    if (userOperationInput.l1DataGas !== undefined) {
      userOperation.l1DataGas = parseHexField(userOperationInput.l1DataGas, "l1DataGas");
    }

    if (userOperation.paymasterAndData !== undefined && userOperation.paymasterAndData !== "0x") {
      try {
        const normalized = normalizePaymasterAndData({
          paymasterAndData: userOperation.paymasterAndData,
          paymasterVerificationGasLimit:
            userOperation.paymasterVerificationGasLimit === undefined
              ? undefined
              : hexToBigInt(userOperation.paymasterVerificationGasLimit),
          paymasterPostOpGasLimit:
            userOperation.paymasterPostOpGasLimit === undefined
              ? undefined
              : hexToBigInt(userOperation.paymasterPostOpGasLimit),
        });

        userOperation.paymasterAndData = normalized.paymasterAndData;
        userOperation.paymasterVerificationGasLimit ??= bigIntToHex(
          normalized.paymasterVerificationGasLimit,
        );
        userOperation.paymasterPostOpGasLimit ??= bigIntToHex(normalized.paymasterPostOpGasLimit);
      } catch (error) {
        throw new BundlerRpcError(
          RPC_INVALID_PARAMS,
          error instanceof Error ? error.message : "Invalid paymasterAndData",
          {
            reason: "paymaster_data_invalid",
          },
        );
      }
    }

    return userOperation;
  }

  private parseUserOpHash(hashInput: unknown): string {
    return this.parseHash(hashInput, "userOpHash");
  }

  private parseHash(hashInput: unknown, fieldName: string): string {
    if (typeof hashInput !== "string") {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, `${fieldName} must be a hex string`, {
        reason: "hash_invalid_type",
        field: fieldName,
      });
    }

    const normalized = normalizeHex(hashInput);
    if (normalized.length !== 66) {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, `${fieldName} must be 32 bytes`, {
        reason: "hash_invalid_length",
        field: fieldName,
      });
    }

    return normalized;
  }

  private parseBundleSubmission(submissionInput: unknown): BundleSubmission {
    if (!isObject(submissionInput)) {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "Submission payload must be an object", {
        reason: "submission_invalid",
      });
    }

    const transactionHash = this.parseHash(
      submissionInput.transactionHash,
      "transactionHash",
    ) as HexString;
    const blockHash = this.parseHash(submissionInput.blockHash, "blockHash") as HexString;
    if (
      typeof submissionInput.blockNumber !== "number" ||
      !Number.isInteger(submissionInput.blockNumber) ||
      submissionInput.blockNumber < 0
    ) {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "blockNumber must be a non-negative integer", {
        reason: "block_number_invalid",
      });
    }

    return {
      transactionHash,
      blockNumber: submissionInput.blockNumber,
      blockHash,
      gasUsed: parseHexField(submissionInput.gasUsed, "gasUsed"),
      gasCost: parseHexField(submissionInput.gasCost, "gasCost"),
      effectiveGasPrice:
        submissionInput.effectiveGasPrice === undefined
          ? undefined
          : parseHexField(submissionInput.effectiveGasPrice, "effectiveGasPrice"),
      success: submissionInput.success === undefined ? true : Boolean(submissionInput.success),
      reason: submissionInput.reason === undefined ? undefined : String(submissionInput.reason),
      revertReason:
        submissionInput.revertReason === undefined
          ? undefined
          : String(submissionInput.revertReason),
    };
  }

  private assertEntryPointSupported(entryPoint: string): void {
    if (!this.config.entryPoints.includes(entryPoint)) {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "Unsupported entry point", {
        reason: "entrypoint_unsupported",
        entryPoint,
      });
    }
  }

  private ensureSenderCanSubmit(sender: string): void {
    const now = Date.now();
    const reputation = this.getSenderReputation(sender, now);
    if (!reputation) {
      return;
    }

    if (reputation.bannedUntil !== null && reputation.bannedUntil > now) {
      throw new BundlerRpcError(RPC_RESOURCE_UNAVAILABLE, "Sender is temporarily banned", {
        reason: "sender_banned",
        sender,
        bannedUntil: reputation.bannedUntil,
      });
    }

    if (reputation.throttledUntil !== null && reputation.throttledUntil > now) {
      throw new BundlerRpcError(RPC_RESOURCE_UNAVAILABLE, "Sender is temporarily throttled", {
        reason: "sender_throttled",
        sender,
        throttledUntil: reputation.throttledUntil,
        retryAfterMs: reputation.throttledUntil - now,
      });
    }
  }

  private getSenderReputation(sender: string, now: number = Date.now()): SenderReputation | null {
    const reputation = this.senderReputation.get(sender);
    if (!reputation) {
      return null;
    }

    if (
      reputation.windowStartedAt !== null &&
      now - reputation.windowStartedAt >= this.config.reputationWindowMs
    ) {
      this.clearSenderReputation(sender);
      return null;
    }

    let updated = false;
    if (reputation.bannedUntil !== null && reputation.bannedUntil <= now) {
      reputation.bannedUntil = null;
      updated = true;
    }
    if (reputation.throttledUntil !== null && reputation.throttledUntil <= now) {
      reputation.throttledUntil = null;
      updated = true;
    }

    if (
      reputation.failures <= 0 &&
      reputation.bannedUntil === null &&
      reputation.throttledUntil === null
    ) {
      this.clearSenderReputation(sender);
      return null;
    }

    if (updated) {
      this.saveSenderReputation(sender, reputation);
    }

    return reputation;
  }

  private clearSenderReputation(sender: string): void {
    this.senderReputation.delete(sender);
    this.persistence?.deleteSenderReputation(sender);
  }

  private saveSenderReputation(sender: string, reputation: SenderReputation): void {
    this.persistence?.saveSenderReputation(
      sender,
      reputation.failures,
      reputation.windowStartedAt,
      reputation.throttledUntil,
      reputation.bannedUntil,
    );
  }

  private recordDeterministicValidationFailure(sender: string): void {
    const now = Date.now();
    const current = this.getSenderReputation(sender, now) ?? {
      failures: 0,
      windowStartedAt: now,
      throttledUntil: null,
      bannedUntil: null,
    };

    const nextFailures = current.failures + 1;
    const next: SenderReputation = {
      failures: nextFailures,
      windowStartedAt: current.windowStartedAt ?? now,
      throttledUntil: null,
      bannedUntil: null,
    };

    if (nextFailures >= this.config.reputationBanFailures) {
      next.bannedUntil = now + this.config.banWindowMs;
      logEvent("warn", "bundler.sender_banned", {
        sender,
        failures: nextFailures,
        bannedUntil: next.bannedUntil,
      });
    } else if (nextFailures >= this.config.reputationThrottleFailures) {
      next.throttledUntil = now + this.config.throttleWindowMs;
      logEvent("warn", "bundler.sender_throttled", {
        sender,
        failures: nextFailures,
        throttledUntil: next.throttledUntil,
      });
    } else {
      logEvent("warn", "bundler.sender_validation_warning", {
        sender,
        failures: nextFailures,
      });
    }

    this.senderReputation.set(sender, next);
    this.saveSenderReputation(sender, next);
  }

  private buildUserOpHash(userOperation: UserOperation, entryPoint: HexString): string {
    return buildCanonicalUserOpHash(userOperation, entryPoint, this.config.chainId);
  }

  private buildDeterministicHash(input: string): string {
    return `0x${createHash("sha256").update(input).digest("hex")}`;
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
    "https://rpc.mainnet.taiko.xyz";
  const service = new BundlerService(
    {
      chainId,
      acceptUserOperations: submissionEnabled,
      maxFinalizedOperations: parsePositiveIntegerWithFallback(
        process.env.BUNDLER_MAX_FINALIZED_OPERATIONS,
        10_000,
      ),
      gasSimulator: new ViemGasSimulator(chainRpcUrl, chain),
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
