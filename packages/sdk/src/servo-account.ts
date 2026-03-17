import {
  type Address,
  type Hex,
  concatHex,
  encodeFunctionData,
  isAddress,
  parseAbi,
  type PublicClient,
} from "viem";

import type { ServoCall } from "./types.js";

const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;
const UINT256_MAX = (1n << 256n) - 1n;

export const SERVO_ACCOUNT_FACTORY_ABI = parseAbi([
  "function createAccount(address owner, uint256 salt) returns (address)",
  "function getAddress(address owner, uint256 salt) view returns (address)",
]);

export const SERVO_ACCOUNT_ABI = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] calldatas)",
]);

const assertAddress = (value: string, fieldName: string): Address => {
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${fieldName} must be a valid address`);
  }

  return value.toLowerCase() as Address;
};

const assertHex = (value: string, fieldName: string): Hex => {
  if (!HEX_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be a hex string`);
  }

  return value.toLowerCase() as Hex;
};

const assertUint256 = (value: bigint, fieldName: string): bigint => {
  if (value < 0n || value > UINT256_MAX) {
    throw new Error(`${fieldName} must fit uint256`);
  }

  return value;
};

export interface GetCounterfactualAddressInput {
  publicClient: PublicClient;
  factoryAddress: Address;
  owner: Address;
  salt: bigint;
}

export const getCounterfactualAddress = async ({
  publicClient,
  factoryAddress,
  owner,
  salt,
}: GetCounterfactualAddressInput): Promise<Address> => {
  const address = await publicClient.readContract({
    address: assertAddress(factoryAddress, "factoryAddress"),
    abi: SERVO_ACCOUNT_FACTORY_ABI,
    functionName: "getAddress",
    args: [assertAddress(owner, "owner"), assertUint256(salt, "salt")],
  });

  return assertAddress(address, "counterfactualAddress");
};

export interface BuildInitCodeInput {
  factoryAddress: Address;
  owner: Address;
  salt: bigint;
}

export const buildInitCode = ({ factoryAddress, owner, salt }: BuildInitCodeInput): Hex => {
  const calldata = encodeFunctionData({
    abi: SERVO_ACCOUNT_FACTORY_ABI,
    functionName: "createAccount",
    args: [assertAddress(owner, "owner"), assertUint256(salt, "salt")],
  });

  return concatHex([
    assertAddress(factoryAddress, "factoryAddress") as Hex,
    assertHex(calldata, "createAccount calldata"),
  ]);
};

interface NormalizedCall {
  target: Address;
  value: bigint;
  data: Hex;
}

const normalizeCall = (call: ServoCall, index: number): NormalizedCall => ({
  target: assertAddress(call.target, `calls[${index}].target`),
  value: assertUint256(call.value ?? 0n, `calls[${index}].value`),
  data: assertHex(call.data, `calls[${index}].data`),
});

export const buildServoExecuteCallData = (call: ServoCall): Hex => {
  const normalized = normalizeCall(call, 0);

  return encodeFunctionData({
    abi: SERVO_ACCOUNT_ABI,
    functionName: "execute",
    args: [normalized.target, normalized.value, normalized.data],
  });
};

export const buildServoExecuteBatchCallData = (calls: ServoCall[]): Hex => {
  if (calls.length === 0) {
    throw new Error("calls must contain at least one item");
  }

  const normalized = calls.map((call, index) => normalizeCall(call, index));

  return encodeFunctionData({
    abi: SERVO_ACCOUNT_ABI,
    functionName: "executeBatch",
    args: [
      normalized.map((call) => call.target),
      normalized.map((call) => call.value),
      normalized.map((call) => call.data),
    ],
  });
};

export const buildServoCallData = (calls: ServoCall[]): Hex => {
  if (calls.length === 0) {
    throw new Error("calls must contain at least one item");
  }

  if (calls.length === 1) {
    return buildServoExecuteCallData(calls[0]!);
  }

  return buildServoExecuteBatchCallData(calls);
};
