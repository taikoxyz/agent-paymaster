import { concatHex, encodeFunctionData, parseAbi, type PublicClient } from "viem";

import { AgentPaymasterSdkError } from "./errors.js";
import type { Address, HexString, ServoCall } from "./types.js";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
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

const normalizeAddress = (value: string, fieldName: string): Address => {
  if (!ADDRESS_PATTERN.test(value)) {
    throw new AgentPaymasterSdkError("invalid_address", `${fieldName} must be a valid address`);
  }

  return value as Address;
};

const normalizeHex = (value: string, fieldName: string): HexString => {
  if (!HEX_PATTERN.test(value)) {
    throw new AgentPaymasterSdkError("invalid_hex", `${fieldName} must be a hex string`);
  }

  return value.toLowerCase() as HexString;
};

const normalizeUint256 = (value: bigint, fieldName: string): bigint => {
  if (value < 0n || value > UINT256_MAX) {
    throw new AgentPaymasterSdkError("invalid_number", `${fieldName} must fit uint256`);
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
    address: normalizeAddress(factoryAddress, "factoryAddress"),
    abi: SERVO_ACCOUNT_FACTORY_ABI,
    functionName: "getAddress",
    args: [normalizeAddress(owner, "owner"), normalizeUint256(salt, "salt")],
  });

  return normalizeAddress(address, "counterfactualAddress");
};

export interface BuildInitCodeInput {
  factoryAddress: Address;
  owner: Address;
  salt: bigint;
}

export const buildInitCode = ({ factoryAddress, owner, salt }: BuildInitCodeInput): HexString => {
  const calldata = encodeFunctionData({
    abi: SERVO_ACCOUNT_FACTORY_ABI,
    functionName: "createAccount",
    args: [normalizeAddress(owner, "owner"), normalizeUint256(salt, "salt")],
  });

  return concatHex([
    normalizeAddress(factoryAddress, "factoryAddress") as HexString,
    normalizeHex(calldata, "createAccount calldata"),
  ]);
};

const normalizeCall = (call: ServoCall, index: number): ServoCall => {
  const value = call.value ?? 0n;

  return {
    target: normalizeAddress(call.target, `calls[${index}].target`),
    value: normalizeUint256(value, `calls[${index}].value`),
    data: normalizeHex(call.data, `calls[${index}].data`),
  };
};

export const buildServoExecuteCallData = (call: ServoCall): HexString => {
  const normalized = normalizeCall(call, 0);

  return encodeFunctionData({
    abi: SERVO_ACCOUNT_ABI,
    functionName: "execute",
    args: [normalized.target, normalized.value ?? 0n, normalized.data],
  });
};

export const buildServoExecuteBatchCallData = (calls: ServoCall[]): HexString => {
  if (calls.length === 0) {
    throw new AgentPaymasterSdkError("invalid_calls", "calls must contain at least one item");
  }

  const normalized = calls.map((call, index) => normalizeCall(call, index));

  return encodeFunctionData({
    abi: SERVO_ACCOUNT_ABI,
    functionName: "executeBatch",
    args: [
      normalized.map((call) => call.target),
      normalized.map((call) => call.value ?? 0n),
      normalized.map((call) => call.data),
    ],
  });
};

export const buildServoCallData = (calls: ServoCall[]): HexString => {
  if (calls.length === 0) {
    throw new AgentPaymasterSdkError("invalid_calls", "calls must contain at least one item");
  }

  if (calls.length === 1) {
    return buildServoExecuteCallData(calls[0]!);
  }

  return buildServoExecuteBatchCallData(calls);
};
