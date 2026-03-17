import { concatHex, toHex } from "viem";

import { AgentPaymasterSdkError } from "./errors.js";
import type { BuildUserOperationInput, HexString, UserOperation } from "./types.js";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;
const UINT128_MAX = (1n << 128n) - 1n;

const DEFAULT_DUMMY_SIGNATURE = ("0x" + "11".repeat(32) + "22".repeat(32) + "1b") as HexString;

const assertAddress = (value: string, fieldName: string): `0x${string}` => {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new AgentPaymasterSdkError("invalid_address", `${fieldName} must be a valid address`);
  }

  return value as `0x${string}`;
};

const assertHex = (value: string, fieldName: string): HexString => {
  if (!HEX_PATTERN.test(value)) {
    throw new AgentPaymasterSdkError("invalid_hex", `${fieldName} must be a hex string`);
  }

  return value.toLowerCase() as HexString;
};

export const buildDummySignature = (): HexString => DEFAULT_DUMMY_SIGNATURE;

export const buildUserOp = (input: BuildUserOperationInput): UserOperation => {
  const signature =
    input.signature === undefined ? buildDummySignature() : assertHex(input.signature, "signature");

  if (signature === "0x") {
    throw new AgentPaymasterSdkError(
      "invalid_signature",
      "signature cannot be empty; use buildDummySignature() for estimation/quote steps",
    );
  }

  return {
    sender: assertAddress(input.sender, "sender"),
    nonce: assertHex(input.nonce, "nonce"),
    initCode: assertHex(input.initCode ?? "0x", "initCode"),
    callData: assertHex(input.callData, "callData"),
    callGasLimit:
      input.callGasLimit === undefined ? undefined : assertHex(input.callGasLimit, "callGasLimit"),
    verificationGasLimit:
      input.verificationGasLimit === undefined
        ? undefined
        : assertHex(input.verificationGasLimit, "verificationGasLimit"),
    preVerificationGas:
      input.preVerificationGas === undefined
        ? undefined
        : assertHex(input.preVerificationGas, "preVerificationGas"),
    paymasterVerificationGasLimit:
      input.paymasterVerificationGasLimit === undefined
        ? undefined
        : assertHex(input.paymasterVerificationGasLimit, "paymasterVerificationGasLimit"),
    paymasterPostOpGasLimit:
      input.paymasterPostOpGasLimit === undefined
        ? undefined
        : assertHex(input.paymasterPostOpGasLimit, "paymasterPostOpGasLimit"),
    maxFeePerGas: assertHex(input.maxFeePerGas, "maxFeePerGas"),
    maxPriorityFeePerGas: assertHex(input.maxPriorityFeePerGas, "maxPriorityFeePerGas"),
    paymasterAndData:
      input.paymasterAndData === undefined
        ? undefined
        : assertHex(input.paymasterAndData, "paymasterAndData"),
    signature,
    l1DataGas: input.l1DataGas === undefined ? undefined : assertHex(input.l1DataGas, "l1DataGas"),
  };
};

const hexToBigInt = (value: HexString): bigint => (value === "0x" ? 0n : BigInt(value));

const toUint128 = (value: bigint, fieldName: string): bigint => {
  if (value < 0n || value > UINT128_MAX) {
    throw new AgentPaymasterSdkError("invalid_number", `${fieldName} exceeds uint128 range`);
  }

  return value;
};

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

export const packUserOperation = (userOperation: UserOperation): PackedUserOperation => {
  if (userOperation.callGasLimit === undefined) {
    throw new AgentPaymasterSdkError(
      "invalid_userop",
      "callGasLimit is required for signing/submission",
    );
  }

  if (userOperation.verificationGasLimit === undefined) {
    throw new AgentPaymasterSdkError(
      "invalid_userop",
      "verificationGasLimit is required for signing/submission",
    );
  }

  if (userOperation.preVerificationGas === undefined) {
    throw new AgentPaymasterSdkError(
      "invalid_userop",
      "preVerificationGas is required for signing/submission",
    );
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
