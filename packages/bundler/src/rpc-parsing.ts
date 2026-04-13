import {
  ADDRESS_PATTERN,
  bigIntToHex,
  hexToBigInt,
  isJsonRpcId,
  isObject,
  normalizePaymasterAndData,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  type HexString,
  type JsonRpcId,
  type JsonRpcRequest,
} from "@agent-paymaster/shared";

import type { UserOperation, UserOperationReceiptLog } from "./types.js";

interface BundlerRpcErrorData {
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

const normalizeHex = (value: string): HexString => {
  if (!HEX_PATTERN.test(value)) {
    throw new BundlerRpcError(RPC_INVALID_PARAMS, "Expected a hex string", {
      reason: "hex_required",
    });
  }

  return value.toLowerCase() as HexString;
};

export const parseHexQuantity = (value: string): bigint => {
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

const parseOptionalHexQuantity = (value: unknown, fieldName: string): HexString | undefined => {
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

const parseReceiptLog = (logInput: unknown, index: number): UserOperationReceiptLog => {
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
  logs?: UserOperationReceiptLog[];
}

export const parseJsonRpcRequest = (
  payload: unknown,
):
  | { ok: true; request: JsonRpcRequest }
  | { ok: false; id: JsonRpcId; code: number; message: string; data?: BundlerRpcErrorData } => {
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
};

export const parsePositionalParams = (
  method: string,
  params: unknown,
  expectedCount: number,
): unknown[] => {
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
};

export const parseEntryPoint = (entryPointInput: unknown): HexString => {
  if (typeof entryPointInput !== "string") {
    throw new BundlerRpcError(RPC_INVALID_PARAMS, "entryPoint must be a string", {
      reason: "entrypoint_invalid_type",
    });
  }

  return normalizeAddress(entryPointInput);
};

const parseOptionalChainId = (chainIdInput: unknown): number | null => {
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
};

export const parseUserOperation = (userOperationInput: unknown, chainId: number): UserOperation => {
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
  const parsedChainId = parseOptionalChainId(userOperationInput.chainId);
  if (parsedChainId !== null && parsedChainId !== chainId) {
    throw new BundlerRpcError(
      RPC_INVALID_PARAMS,
      `userOperation.chainId must match bundler chainId (${chainId})`,
      {
        reason: "chain_id_mismatch",
        expectedChainId: chainId,
        submittedChainId: parsedChainId,
      },
    );
  }

  const initCode = resolveInitCode(userOperationInput);

  const userOperation: UserOperation = {
    sender,
    nonce: parseHexField(userOperationInput.nonce, "nonce"),
    initCode,
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
};

export const parseSendUserOperationParams = (
  input: SendUserOperationParamsInput,
  chainId: number,
): ParsedSendUserOperationParams => {
  return {
    userOperation: parseUserOperation(input.userOperation, chainId),
    entryPoint: parseEntryPoint(input.entryPoint),
  };
};

export const assertEntryPointSupported = (
  entryPoint: string,
  entryPoints: readonly string[],
): void => {
  if (!entryPoints.includes(entryPoint)) {
    throw new BundlerRpcError(RPC_INVALID_PARAMS, "Unsupported entry point", {
      reason: "entrypoint_unsupported",
      entryPoint,
    });
  }
};

export const parseBundleSubmission = (submissionInput: unknown): BundleSubmission => {
  if (!isObject(submissionInput)) {
    throw new BundlerRpcError(RPC_INVALID_PARAMS, "Submission payload must be an object", {
      reason: "submission_invalid",
    });
  }

  const transactionHash = parseHashField(
    submissionInput.transactionHash,
    "transactionHash",
  ) as HexString;
  const blockHash = parseHashField(submissionInput.blockHash, "blockHash") as HexString;
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
      submissionInput.revertReason === undefined ? undefined : String(submissionInput.revertReason),
    logs: Array.isArray(submissionInput.logs)
      ? submissionInput.logs.map((log, index) => parseReceiptLog(log, index))
      : undefined,
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
const resolveInitCode = (input: Record<string, unknown>): HexString => {
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
