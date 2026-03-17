import {
  buildHealth,
  normalizePaymasterAndData,
  SERVO_SUPPORTED_ENTRY_POINTS,
} from "@agent-paymaster/shared";
import { serve } from "@hono/node-server";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { taiko } from "viem/chains";

import { buildCanonicalUserOpHash } from "./entrypoint.js";
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
  blockHash: string | null;
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
    blockHash: string;
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
  bannedUntil: number | null;
}

interface StoredUserOperation {
  hash: string;
  userOperation: UserOperation;
  entryPoint: HexString;
  receivedAt: number;
  state: "pending" | "submitting" | "included" | "failed";
  bundleHash: string | null;
  submissionTxHash: HexString | null;
  submissionStartedAt: number | null;
  transactionHash: string | null;
  blockNumber: number | null;
  reason: string | null;
  gasUsed: bigint | null;
  gasCost: bigint | null;
  effectiveGasPrice: bigint | null;
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
  saveSenderReputation(sender: string, failures: number, bannedUntil: number | null): void;
  deleteSenderReputation(sender: string): void;
  loadSenderReputations(): Array<{
    sender: string;
    failures: number;
    bannedUntil: number | null;
  }>;
  deleteExpiredSenderReputations(nowMs?: number): void;
}

interface BundlerConfigInput {
  chainId?: number;
  entryPoints?: string[];
  acceptUserOperations?: boolean;
  reputationMaxFailures?: number;
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
}

interface BundlerConfig {
  chainId: number;
  entryPoints: string[];
  acceptUserOperations: boolean;
  reputationMaxFailures: number;
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
  transactionHash: string;
  blockNumber: number;
  gasUsed: HexString;
  gasCost: HexString;
  effectiveGasPrice?: HexString;
  success?: boolean;
  reason?: string;
  revertReason?: string;
}

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

export class BundlerService {
  readonly config: BundlerConfig;

  private readonly userOperations = new Map<string, StoredUserOperation>();
  private readonly bundles = new Map<string, string[]>();
  private readonly senderReputation = new Map<string, SenderReputation>();
  private readonly persistence?: BundlerPersistence;
  private bundleSequence = 0;

  constructor(config: BundlerConfigInput = {}, persistence?: BundlerPersistence) {
    this.config = {
      chainId: config.chainId ?? 167000,
      entryPoints:
        config.entryPoints?.map((entryPoint) => normalizeAddress(entryPoint)) ?? [
          ...SERVO_SUPPORTED_ENTRY_POINTS,
        ],
      acceptUserOperations: config.acceptUserOperations ?? true,
      reputationMaxFailures: config.reputationMaxFailures ?? 3,
      banWindowMs: config.banWindowMs ?? 5 * 60 * 1000,
      baseCallGas: config.baseCallGas ?? 55_000n,
      baseVerificationGas: config.baseVerificationGas ?? 120_000n,
      basePreVerificationGas: config.basePreVerificationGas ?? 21_000n,
      perByteCallDataGas: config.perByteCallDataGas ?? 16n,
      perByteVerificationGas: config.perByteVerificationGas ?? 4n,
      perBytePreVerificationGas: config.perBytePreVerificationGas ?? 4n,
      l1DataGasScalar: config.l1DataGasScalar ?? 1n,
      paymasterVerificationGasLimit: config.paymasterVerificationGasLimit ?? 120_000n,
      paymasterPostOpGasLimit: config.paymasterPostOpGasLimit ?? 80_000n,
    };

    this.persistence = persistence;

    if (persistence) {
      this.loadFromPersistence(persistence);
    }
  }

  private loadFromPersistence(persistence: BundlerPersistence): void {
    persistence.deleteExpiredSenderReputations();

    for (const entry of persistence.loadPendingOperations()) {
      this.userOperations.set(entry.hash, {
        hash: entry.hash,
        userOperation: entry.userOperation,
        entryPoint: entry.entryPoint,
        receivedAt: entry.receivedAt,
        state: entry.state,
        bundleHash: null,
        submissionTxHash: entry.submissionTxHash,
        submissionStartedAt: entry.submissionStartedAt,
        transactionHash: null,
        blockNumber: null,
        reason: null,
        gasUsed: null,
        gasCost: null,
        effectiveGasPrice: null,
      });
    }

    for (const reputation of persistence.loadSenderReputations()) {
      this.senderReputation.set(reputation.sender, {
        failures: reputation.failures,
        bannedUntil: reputation.bannedUntil,
      });
    }
  }

  getHealth() {
    const now = Date.now();
    let pending = 0;
    let submitting = 0;
    let bannedSenders = 0;

    for (const operation of this.userOperations.values()) {
      if (operation.state === "pending") {
        pending += 1;
        continue;
      }

      if (operation.state === "submitting") {
        submitting += 1;
      }
    }

    for (const reputation of this.senderReputation.values()) {
      if (reputation.bannedUntil !== null && reputation.bannedUntil > now) {
        bannedSenders += 1;
      }
    }

    return {
      ...buildHealth("bundler"),
      chainId: this.config.chainId,
      entryPoints: this.config.entryPoints,
      acceptsUserOperations: this.config.acceptUserOperations,
      pendingUserOperations: pending,
      submittingUserOperations: submitting,
      bannedSenders,
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

  estimateUserOperationGas(
    userOperationInput: unknown,
    entryPointInput: unknown,
  ): UserOperationGasEstimate {
    const userOperation = this.parseUserOperation(userOperationInput);
    const entryPoint = this.parseEntryPoint(entryPointInput);

    this.assertEntryPointSupported(entryPoint);

    const callDataBytes = getBytesLength(userOperation.callData);
    const initCodeBytes = getBytesLength(userOperation.initCode);

    const callGasLimit =
      userOperation.callGasLimit !== undefined
        ? hexToBigInt(userOperation.callGasLimit)
        : this.config.baseCallGas + callDataBytes * this.config.perByteCallDataGas;

    const verificationGasLimit =
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

    return {
      callGasLimit: bigIntToHex(callGasLimit),
      verificationGasLimit: bigIntToHex(verificationGasLimit),
      preVerificationGas: bigIntToHex(preVerificationGas),
      paymasterVerificationGasLimit: bigIntToHex(this.config.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: bigIntToHex(this.config.paymasterPostOpGasLimit),
    };
  }

  sendUserOperation(userOperationInput: unknown, entryPointInput: unknown): string {
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

    this.ensureSenderNotBanned(parsed.userOperation.sender);
    this.assertEntryPointSupported(parsed.entryPoint);

    const userOpHash = this.buildUserOpHash(parsed.userOperation, parsed.entryPoint);
    const matchingPendingOperation = this.findOpenOperationBySenderAndNonce(
      parsed.userOperation.sender,
      hexToBigInt(parsed.userOperation.nonce),
    );

    if (matchingPendingOperation && matchingPendingOperation.hash !== userOpHash) {
      throw new BundlerRpcError(
        RPC_RESOURCE_UNAVAILABLE,
        "Conflicting pending operation for sender and nonce",
        {
          reason: "nonce_conflict",
          sender: parsed.userOperation.sender,
          nonce: parsed.userOperation.nonce,
          conflictingUserOpHash: matchingPendingOperation.hash,
        },
      );
    }

    if (this.userOperations.has(userOpHash)) {
      return userOpHash;
    }

    const receivedAt = Date.now();

    this.userOperations.set(userOpHash, {
      hash: userOpHash,
      userOperation: parsed.userOperation,
      entryPoint: parsed.entryPoint,
      receivedAt,
      state: "pending",
      bundleHash: null,
      submissionTxHash: null,
      submissionStartedAt: null,
      transactionHash: null,
      blockNumber: null,
      reason: null,
      gasUsed: null,
      gasCost: null,
      effectiveGasPrice: null,
    });

    this.persistence?.savePendingOperation(
      userOpHash,
      parsed.entryPoint,
      parsed.userOperation,
      receivedAt,
    );

    return userOpHash;
  }

  getUserOperationByHash(userOpHashInput: unknown): UserOperationLookupResult | null {
    const userOpHash = this.parseUserOpHash(userOpHashInput);
    const operation = this.userOperations.get(userOpHash);
    if (!operation) {
      return null;
    }

    const blockHash =
      operation.transactionHash === null || operation.blockNumber === null
        ? null
        : this.buildDeterministicHash(`${operation.transactionHash}:${operation.blockNumber}`);

    return {
      userOperation: operation.userOperation,
      entryPoint: operation.entryPoint,
      transactionHash: operation.transactionHash,
      blockNumber:
        operation.blockNumber === null ? null : bigIntToHex(BigInt(operation.blockNumber)),
      blockHash,
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
      operation.blockNumber === null
    ) {
      return null;
    }

    const blockHash = this.buildDeterministicHash(
      `${operation.transactionHash}:${operation.blockNumber}`,
    );
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
        blockHash,
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

    operation.state = submission.success ? "included" : "failed";
    operation.bundleHash = null;
    operation.submissionTxHash = null;
    operation.submissionStartedAt = null;
    operation.transactionHash = submission.transactionHash;
    operation.blockNumber = submission.blockNumber;
    operation.reason = submission.success
      ? null
      : (submission.reason ?? submission.revertReason ?? "execution_reverted");
    operation.gasUsed = gasUsed;
    operation.gasCost = gasCost;
    operation.effectiveGasPrice = gasPrice;

    this.persistence?.removePendingOperation(userOpHash);
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
    operation.reason = reason;
    operation.gasUsed = null;
    operation.gasCost = null;
    operation.effectiveGasPrice = null;
    this.recordValidationFailure(operation.userOperation.sender);
    this.persistence?.removePendingOperation(userOpHash);
  }

  handleJsonRpc(payload: unknown): JsonRpcResponse {
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
          const result = this.estimateUserOperationGas(userOperation, entryPoint);
          return makeJsonRpcResult(request.id, result);
        }
        case "eth_sendUserOperation": {
          const [userOperation, entryPoint] = this.parsePositionalParams(
            request.method,
            request.params,
            2,
          );
          const hash = this.sendUserOperation(userOperation, entryPoint);
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
    try {
      return {
        userOperation: this.parseUserOperation(input.userOperation),
        entryPoint: this.parseEntryPoint(input.entryPoint),
      };
    } catch (error) {
      if (isObject(input.userOperation) && typeof input.userOperation.sender === "string") {
        const sender = input.userOperation.sender;
        if (ADDRESS_PATTERN.test(sender)) {
          this.recordValidationFailure(sender.toLowerCase());
        }
      }

      throw error;
    }
  }

  private parseEntryPoint(entryPointInput: unknown): HexString {
    if (typeof entryPointInput !== "string") {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "entryPoint must be a string", {
        reason: "entrypoint_invalid_type",
      });
    }

    return normalizeAddress(entryPointInput);
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

    const transactionHash = this.parseHash(submissionInput.transactionHash, "transactionHash");
    if (
      typeof submissionInput.blockNumber !== "number" ||
      !Number.isInteger(submissionInput.blockNumber)
    ) {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "blockNumber must be an integer", {
        reason: "block_number_invalid",
      });
    }

    return {
      transactionHash,
      blockNumber: submissionInput.blockNumber,
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

  private ensureSenderNotBanned(sender: string): void {
    const reputation = this.senderReputation.get(sender);
    if (!reputation || reputation.bannedUntil === null) {
      return;
    }

    if (reputation.bannedUntil <= Date.now()) {
      this.senderReputation.delete(sender);
      this.persistence?.deleteSenderReputation(sender);
      return;
    }

    throw new BundlerRpcError(RPC_RESOURCE_UNAVAILABLE, "Sender is temporarily banned", {
      reason: "sender_banned",
      sender,
      bannedUntil: reputation.bannedUntil,
    });
  }

  private recordValidationFailure(sender: string): void {
    const current = this.senderReputation.get(sender) ?? {
      failures: 0,
      bannedUntil: null,
    };

    const nextFailures = current.failures + 1;
    const bannedUntil =
      nextFailures >= this.config.reputationMaxFailures
        ? Date.now() + this.config.banWindowMs
        : current.bannedUntil;

    this.senderReputation.set(sender, {
      failures: nextFailures,
      bannedUntil,
    });
    this.persistence?.saveSenderReputation(sender, nextFailures, bannedUntil);
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

    const response = service.handleJsonRpc(payload);
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
  const service = new BundlerService(
    {
      acceptUserOperations: submissionEnabled,
    },
    persistence,
  );

  const submitterMonitor: BundlerHealthMonitor = submissionEnabled
    ? new BundlerSubmitter(service, {
        privateKey: submitterPrivateKey as HexString,
        chain: taiko,
        chainRpcUrl:
          process.env.BUNDLER_CHAIN_RPC_URL?.trim() ||
          process.env.TAIKO_RPC_URL?.trim() ||
          process.env.TAIKO_MAINNET_RPC_URL?.trim() ||
          "https://rpc.mainnet.taiko.xyz",
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

  console.log(`Bundler RPC listening on :${port}`);
}
