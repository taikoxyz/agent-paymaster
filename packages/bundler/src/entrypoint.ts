import {
  BaseError,
  ContractFunctionRevertedError,
  concatHex,
  decodeAbiParameters,
  decodeErrorResult,
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  toHex,
} from "viem";

import { hexToBigInt, UINT128_MAX, type HexString } from "@agent-paymaster/shared";
import type { UserOperation } from "./types.js";

export interface PackedUserOperation {
  sender: HexString;
  nonce: bigint;
  initCode: HexString;
  callData: HexString;
  accountGasLimits: HexString;
  preVerificationGas: bigint;
  gasFees: HexString;
  paymasterAndData: HexString;
  signature: HexString;
}

export interface UserOperationExecution {
  userOpHash: string;
  success: boolean;
  actualGasCost: bigint;
  actualGasUsed: bigint;
  revertReason: string | null;
}

interface ReceiptLog {
  address: string;
  data: HexString;
  topics: readonly HexString[];
}

export const ENTRY_POINT_ABI = parseAbi([
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary)",
  "event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)",
  "event UserOperationRevertReason(bytes32 indexed userOpHash,address indexed sender,uint256 nonce,bytes revertReason)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
  "error PostOpReverted(bytes returnData)",
]);

export const ENTRY_POINT_SIMULATION_ABI = parseAbi([
  "function simulateValidation((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp)",
  "error ValidationResult((uint256 preOpGas,uint256 prefund,bool sigFailed,uint48 validAfter,uint48 validUntil,bytes paymasterContext) returnInfo,(uint256 stake,uint256 unstakeDelaySec) senderInfo,(uint256 stake,uint256 unstakeDelaySec) factoryInfo,(uint256 stake,uint256 unstakeDelaySec) paymasterInfo)",
  "error ValidationResultWithAggregation((uint256 preOpGas,uint256 prefund,bool sigFailed,uint48 validAfter,uint48 validUntil,bytes paymasterContext) returnInfo,(uint256 stake,uint256 unstakeDelaySec) senderInfo,(uint256 stake,uint256 unstakeDelaySec) factoryInfo,(uint256 stake,uint256 unstakeDelaySec) paymasterInfo,(address aggregator,(uint256 stake,uint256 unstakeDelaySec) stakeInfo) aggregatorInfo)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
  "error PostOpReverted(bytes returnData)",
]);

const ERROR_STRING_SELECTOR = "0x08c379a0";
const PANIC_SELECTOR = "0x4e487b71";

const toUint128 = (value: bigint, fieldName: string): bigint => {
  if (value < 0n || value > UINT128_MAX) {
    throw new Error(`${fieldName} exceeds uint128`);
  }

  return value;
};

const decodeRevertReason = (payload: HexString): string => {
  if (payload.length < 10) {
    return payload;
  }

  if (payload.startsWith(ERROR_STRING_SELECTOR)) {
    try {
      const [reason] = decodeAbiParameters([{ type: "string" }], `0x${payload.slice(10)}`);
      return String(reason);
    } catch {
      return payload;
    }
  }

  if (payload.startsWith(PANIC_SELECTOR)) {
    try {
      const [panicCode] = decodeAbiParameters([{ type: "uint256" }], `0x${payload.slice(10)}`);
      return `panic(${panicCode})`;
    } catch {
      return payload;
    }
  }

  return payload;
};

export const packUserOperation = (userOperation: UserOperation): PackedUserOperation => {
  if (userOperation.callGasLimit === undefined) {
    throw new Error("callGasLimit is required for on-chain submission");
  }

  if (userOperation.verificationGasLimit === undefined) {
    throw new Error("verificationGasLimit is required for on-chain submission");
  }

  if (userOperation.preVerificationGas === undefined) {
    throw new Error("preVerificationGas is required for on-chain submission");
  }

  const verificationGasLimit = toUint128(
    hexToBigInt(userOperation.verificationGasLimit),
    "verificationGasLimit",
  );
  const callGasLimit = toUint128(hexToBigInt(userOperation.callGasLimit), "callGasLimit");
  const maxPriorityFeePerGas = toUint128(
    hexToBigInt(userOperation.maxPriorityFeePerGas),
    "maxPriorityFeePerGas",
  );
  const maxFeePerGas = toUint128(hexToBigInt(userOperation.maxFeePerGas), "maxFeePerGas");

  return {
    sender: userOperation.sender,
    nonce: hexToBigInt(userOperation.nonce),
    initCode: userOperation.initCode,
    callData: userOperation.callData,
    accountGasLimits: concatHex([
      toHex(verificationGasLimit, { size: 16 }),
      toHex(callGasLimit, { size: 16 }),
    ]),
    preVerificationGas: hexToBigInt(userOperation.preVerificationGas),
    gasFees: concatHex([
      toHex(maxPriorityFeePerGas, { size: 16 }),
      toHex(maxFeePerGas, { size: 16 }),
    ]),
    paymasterAndData: userOperation.paymasterAndData ?? "0x",
    signature: userOperation.signature,
  };
};

export const extractBundlerErrorReason = (error: unknown): string => {
  if (error instanceof BaseError) {
    const reverted = error.walk(
      (candidate) => candidate instanceof ContractFunctionRevertedError,
    ) as ContractFunctionRevertedError | null;

    if (reverted) {
      return reverted.reason ?? reverted.shortMessage ?? reverted.message;
    }

    return error.shortMessage ?? error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const decodeSimulationRevertData = (payload: HexString): bigint | null => {
  try {
    const decoded = decodeErrorResult({
      abi: ENTRY_POINT_SIMULATION_ABI,
      data: payload,
    });

    const firstArg = decoded.args[0];
    if (!firstArg || typeof firstArg !== "object" || !("preOpGas" in firstArg)) {
      return null;
    }

    const preOpGas = firstArg.preOpGas;
    return typeof preOpGas === "bigint" ? preOpGas : null;
  } catch {
    return null;
  }
};

const decodeSimulationError = (
  payload: HexString,
): { success: true } | { success: false; reason: string } | null => {
  try {
    const decoded = decodeErrorResult({
      abi: ENTRY_POINT_SIMULATION_ABI,
      data: payload,
    });

    if (
      decoded.errorName === "ValidationResult" ||
      decoded.errorName === "ValidationResultWithAggregation"
    ) {
      return { success: true };
    }

    if (decoded.errorName === "FailedOp") {
      const reason = decoded.args[1];
      return {
        success: false,
        reason: typeof reason === "string" ? reason : "FailedOp",
      };
    }

    if (decoded.errorName === "FailedOpWithRevert") {
      const reason = decoded.args[1];
      const inner = decoded.args[2];
      const baseReason = typeof reason === "string" ? reason : "FailedOpWithRevert";
      if (typeof inner === "string" && inner.startsWith("0x")) {
        return {
          success: false,
          reason: `${baseReason}: ${decodeRevertReason(inner as HexString)}`,
        };
      }
      return { success: false, reason: baseReason };
    }

    if (decoded.errorName === "PostOpReverted") {
      const returnData = decoded.args[0];
      if (typeof returnData === "string" && returnData.startsWith("0x")) {
        return {
          success: false,
          reason: `PostOpReverted: ${decodeRevertReason(returnData as HexString)}`,
        };
      }
      return { success: false, reason: "PostOpReverted" };
    }

    return null;
  } catch {
    return null;
  }
};

const extractRevertPayload = (error: unknown): HexString | null => {
  if (!(error instanceof BaseError)) {
    return null;
  }

  const reverted = error.walk(
    (candidate) => candidate instanceof ContractFunctionRevertedError,
  ) as ContractFunctionRevertedError | null;
  if (!reverted || reverted.data === undefined) {
    return null;
  }

  const revertData = reverted.data as unknown;

  if (typeof revertData === "string" && revertData.startsWith("0x")) {
    return revertData as HexString;
  }

  if (
    typeof revertData === "object" &&
    revertData !== null &&
    "data" in revertData &&
    typeof revertData.data === "string" &&
    revertData.data.startsWith("0x")
  ) {
    return revertData.data as HexString;
  }

  return null;
};

export const extractSimulationPreOpGas = (error: unknown): bigint | null => {
  const payload = extractRevertPayload(error);
  return payload !== null ? decodeSimulationRevertData(payload) : null;
};

export const classifySimulationValidation = (
  error: unknown,
): { success: true } | { success: false; reason: string } | null => {
  const payload = extractRevertPayload(error);
  return payload !== null ? decodeSimulationError(payload) : null;
};

export const collectUserOperationExecutions = (
  entryPoint: string,
  logs: readonly ReceiptLog[],
): Map<string, UserOperationExecution> => {
  const executions = new Map<string, UserOperationExecution>();
  const revertReasons = new Map<string, string>();
  const normalizedEntryPoint = entryPoint.toLowerCase();

  for (const log of logs) {
    if (log.address.toLowerCase() !== normalizedEntryPoint) {
      continue;
    }

    if (log.topics.length === 0) {
      continue;
    }

    try {
      const decoded = decodeEventLog({
        abi: ENTRY_POINT_ABI,
        data: log.data,
        topics: log.topics as [HexString, ...HexString[]],
      });

      if (decoded.eventName === "UserOperationRevertReason") {
        revertReasons.set(
          decoded.args.userOpHash,
          decodeRevertReason(decoded.args.revertReason as HexString),
        );
        continue;
      }

      if (decoded.eventName !== "UserOperationEvent") {
        continue;
      }

      executions.set(decoded.args.userOpHash, {
        userOpHash: decoded.args.userOpHash,
        success: decoded.args.success,
        actualGasCost: decoded.args.actualGasCost,
        actualGasUsed: decoded.args.actualGasUsed,
        revertReason: null,
      });
    } catch {
      continue;
    }
  }

  for (const [userOpHash, revertReason] of revertReasons.entries()) {
    const execution = executions.get(userOpHash);
    if (!execution || execution.success) {
      continue;
    }

    execution.revertReason = revertReason;
  }

  return executions;
};

export const buildCanonicalUserOpHash = (
  userOperation: UserOperation,
  entryPoint: HexString,
  chainId: number,
): string => {
  const callGasLimit = toUint128(
    userOperation.callGasLimit === undefined ? 0n : hexToBigInt(userOperation.callGasLimit),
    "callGasLimit",
  );
  const verificationGasLimit = toUint128(
    userOperation.verificationGasLimit === undefined
      ? 0n
      : hexToBigInt(userOperation.verificationGasLimit),
    "verificationGasLimit",
  );
  const maxPriorityFeePerGas = toUint128(
    hexToBigInt(userOperation.maxPriorityFeePerGas),
    "maxPriorityFeePerGas",
  );
  const maxFeePerGas = toUint128(hexToBigInt(userOperation.maxFeePerGas), "maxFeePerGas");

  const accountGasLimits = concatHex([
    toHex(verificationGasLimit, { size: 16 }),
    toHex(callGasLimit, { size: 16 }),
  ]);
  const gasFees = concatHex([
    toHex(maxPriorityFeePerGas, { size: 16 }),
    toHex(maxFeePerGas, { size: 16 }),
  ]);

  const packedPaymasterAndDataHash =
    userOperation.paymasterAndData !== undefined && userOperation.paymasterAndData !== "0x"
      ? keccak256(userOperation.paymasterAndData)
      : keccak256("0x");

  const packedUserOp = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      userOperation.sender,
      hexToBigInt(userOperation.nonce),
      keccak256(userOperation.initCode),
      keccak256(userOperation.callData),
      accountGasLimits,
      userOperation.preVerificationGas === undefined
        ? 0n
        : hexToBigInt(userOperation.preVerificationGas),
      gasFees,
      packedPaymasterAndDataHash,
    ],
  );

  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [keccak256(packedUserOp), entryPoint, BigInt(chainId)],
    ),
  );
};
