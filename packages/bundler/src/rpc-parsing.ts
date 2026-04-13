import {
  ADDRESS_PATTERN,
  isObject,
  RPC_INVALID_PARAMS,
  type HexString,
} from "@agent-paymaster/shared";

import type { UserOperationReceiptLog } from "./index.js";

export interface BundlerRpcErrorData {
  method?: string;
  reason?: string;
  [key: string]: unknown;
}

export class BundlerRpcError extends Error {
  readonly code: number;
  readonly data?: BundlerRpcErrorData;

  constructor(code: number, message: string, data?: BundlerRpcErrorData) {
    super(message);
    this.name = "BundlerRpcError";
    this.code = code;
    this.data = data;
  }
}

const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;

export const normalizeHex = (value: string): HexString => {
  if (!HEX_PATTERN.test(value)) {
    throw new BundlerRpcError(RPC_INVALID_PARAMS, "Expected a hex string", {
      reason: "hex_required",
    });
  }

  return value.toLowerCase() as HexString;
};

export const hexToBigInt = (value: string): bigint => {
  const normalized = normalizeHex(value);
  if (normalized === "0x") {
    return 0n;
  }

  return BigInt(normalized);
};

export const normalizeAddress = (value: string): HexString => {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new BundlerRpcError(RPC_INVALID_PARAMS, "Expected a valid address", {
      reason: "address_invalid",
    });
  }

  return value.toLowerCase() as HexString;
};

export const parseHexField = (value: unknown, fieldName: string, optional = false): HexString => {
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

export const parseOptionalHexQuantity = (
  value: unknown,
  fieldName: string,
): HexString | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return parseHexField(value, fieldName);
};

export const parseHashField = (value: unknown, fieldName: string): HexString => {
  const normalized = parseHexField(value, fieldName);
  if (normalized.length !== 66) {
    throw new BundlerRpcError(RPC_INVALID_PARAMS, `${fieldName} must be 32 bytes`, {
      reason: "hash_invalid_length",
      field: fieldName,
    });
  }

  return normalized;
};

export const parseReceiptLog = (logInput: unknown, index: number): UserOperationReceiptLog => {
  if (!isObject(logInput)) {
    throw new BundlerRpcError(RPC_INVALID_PARAMS, `logs[${index}] must be an object`, {
      reason: "submission_log_invalid",
      field: `logs[${index}]`,
    });
  }

  if (!Array.isArray(logInput.topics)) {
    throw new BundlerRpcError(RPC_INVALID_PARAMS, `logs[${index}].topics must be an array`, {
      reason: "submission_log_topics_invalid",
      field: `logs[${index}].topics`,
    });
  }

  return {
    address: normalizeAddress(String(logInput.address)),
    data: parseHexField(logInput.data, `logs[${index}].data`),
    topics: logInput.topics.map((topic, topicIndex) =>
      parseHexField(topic, `logs[${index}].topics[${topicIndex}]`),
    ),
    blockHash:
      logInput.blockHash === undefined
        ? undefined
        : parseHashField(logInput.blockHash, `logs[${index}].blockHash`),
    blockNumber: parseOptionalHexQuantity(logInput.blockNumber, `logs[${index}].blockNumber`),
    transactionHash:
      logInput.transactionHash === undefined
        ? undefined
        : parseHashField(logInput.transactionHash, `logs[${index}].transactionHash`),
    transactionIndex: parseOptionalHexQuantity(
      logInput.transactionIndex,
      `logs[${index}].transactionIndex`,
    ),
    logIndex: parseOptionalHexQuantity(logInput.logIndex, `logs[${index}].logIndex`),
    removed: logInput.removed === undefined ? undefined : Boolean(logInput.removed),
  };
};

export const getBytesLength = (hexValue: string): bigint => {
  const normalized = normalizeHex(hexValue);
  const payload = normalized.slice(2);

  if (payload.length % 2 !== 0) {
    throw new BundlerRpcError(RPC_INVALID_PARAMS, "Hex values must have even length", {
      reason: "hex_length_invalid",
    });
  }

  return BigInt(payload.length / 2);
};

/**
 * Resolves initCode from either:
 * - v0.7 RPC format: `factory` + `factoryData` (separate fields, per ERC-4337 spec)
 * - Legacy packed format: `initCode` (factory address concatenated with factoryData)
 * - Neither provided: defaults to "0x" (existing account, no deployment)
 */
export const resolveInitCode = (input: Record<string, unknown>): HexString => {
  const hasInitCode = input.initCode !== undefined && input.initCode !== null;
  const hasFactory = input.factory !== undefined && input.factory !== null;

  if (hasInitCode && hasFactory) {
    throw new BundlerRpcError(
      RPC_INVALID_PARAMS,
      "Provide either initCode or factory/factoryData, not both",
      { reason: "initcode_ambiguous" },
    );
  }

  if (hasFactory) {
    const factory = parseHexField(input.factory, "factory");
    if (factory === "0x") {
      return "0x";
    }
    if (factory.length !== 42) {
      throw new BundlerRpcError(RPC_INVALID_PARAMS, "factory must be a 20-byte address", {
        reason: "factory_invalid_length",
      });
    }
    const factoryData = parseHexField(input.factoryData, "factoryData", true);
    return `${factory}${factoryData.slice(2)}` as HexString;
  }

  if (hasInitCode) {
    return parseHexField(input.initCode, "initCode");
  }

  return "0x";
};
