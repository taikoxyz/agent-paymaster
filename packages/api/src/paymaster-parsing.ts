import {
  ADDRESS_PATTERN,
  type ChainName,
  HEX_BYTES_PATTERN,
  SERVO_SUPPORTED_ENTRY_POINTS,
  UINT128_MAX,
  isObject,
} from "@agent-paymaster/shared";
import { concatHex, toHex } from "viem";

const HEX_QUANTITY_PATTERN = /^0x[0-9a-fA-F]+$/;

export interface ChainConfig {
  name: ChainName;
  chainId: number;
}

export const CHAIN_CONFIGS: ChainConfig[] = [
  { name: "taikoMainnet", chainId: 167000 },
  { name: "taikoHoodi", chainId: 167013 },
];

const CHAIN_BY_ID = new Map(CHAIN_CONFIGS.map((chain) => [chain.chainId, chain] as const));
const CHAIN_BY_NAME = new Map(
  CHAIN_CONFIGS.map((chain) => [chain.name.toLowerCase(), chain] as const),
);

interface GasEstimate {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
}

interface ParsedQuoteInput {
  sender: string;
  entryPoint: string;
  chain: ChainConfig;
  token: "USDC";
  userOperation: Record<string, unknown>;
  userOperationNonce: bigint;
  initCode: `0x${string}`;
  callData: `0x${string}`;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export const normalizeAddress = (value: unknown, fieldName: string): string => {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be a valid 20-byte hex address`);
  }

  return value.toLowerCase();
};

const parseHexQuantity = (value: unknown, fieldName: string): bigint => {
  if (typeof value !== "string" || !HEX_QUANTITY_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be a hex quantity`);
  }

  return BigInt(value);
};

const parseOptionalHexQuantity = (value: unknown, fieldName: string): bigint | null => {
  if (value === undefined || value === null) {
    return null;
  }

  return parseHexQuantity(value, fieldName);
};

const parseBytes = (value: unknown, fieldName: string): `0x${string}` => {
  if (typeof value !== "string" || !HEX_BYTES_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be a hex bytes value`);
  }

  return value.toLowerCase() as `0x${string}`;
};

export const formatUsdcMicros = (microsInput: bigint): string => {
  const micros = microsInput < 0n ? 0n : microsInput;
  const whole = micros / 1_000_000n;
  const fraction = micros % 1_000_000n;
  return `${whole.toString()}.${fraction.toString().padStart(6, "0")}`;
};

const resolveChain = (chainInput: unknown, chainIdInput: unknown): ChainConfig => {
  if (typeof chainIdInput === "number" && Number.isInteger(chainIdInput)) {
    const byId = CHAIN_BY_ID.get(chainIdInput);
    if (byId !== undefined) {
      return byId;
    }
  }

  if (typeof chainInput === "number" && Number.isInteger(chainInput)) {
    const byId = CHAIN_BY_ID.get(chainInput);
    if (byId !== undefined) {
      return byId;
    }
  }

  if (typeof chainInput === "string") {
    const normalized = chainInput.trim().toLowerCase();

    const byName = CHAIN_BY_NAME.get(normalized);
    if (byName !== undefined) {
      return byName;
    }

    if (normalized.startsWith("0x")) {
      const hexPart = normalized.slice(2);
      if (hexPart.length > 0 && /^[0-9a-f]+$/.test(hexPart)) {
        const hexId = Number.parseInt(hexPart, 16);
        if (!Number.isNaN(hexId)) {
          const byId = CHAIN_BY_ID.get(hexId);
          if (byId !== undefined) {
            return byId;
          }
        }
      }
    }

    const maybeId = Number.parseInt(normalized, 10);
    if (!Number.isNaN(maybeId)) {
      const byId = CHAIN_BY_ID.get(maybeId);
      if (byId !== undefined) {
        return byId;
      }
    }
  }

  if (chainInput === undefined && chainIdInput === undefined) {
    return CHAIN_BY_NAME.get("taikomainnet") ?? CHAIN_CONFIGS[0];
  }

  throw new Error("Unsupported chain. Supported values: taikoMainnet, taikoHoodi");
};

export const normalizeOptionalTokenAddresses = (
  tokenAddresses: Partial<Record<ChainName, string>>,
): Partial<Record<ChainName, string>> => {
  const normalized: Partial<Record<ChainName, string>> = {};
  for (const { name } of CHAIN_CONFIGS) {
    if (tokenAddresses[name] !== undefined) {
      normalized[name] = normalizeAddress(tokenAddresses[name], `tokenAddresses.${name}`);
    }
  }
  return normalized;
};

export const normalizeSupportedEntryPoints = (entryPoints: string[] | undefined): string[] => {
  const resolved = entryPoints ?? [...SERVO_SUPPORTED_ENTRY_POINTS];
  if (resolved.length === 0) {
    throw new Error("supportedEntryPoints must contain at least one address");
  }

  return resolved.map((entryPoint) => normalizeAddress(entryPoint, "supportedEntryPoints"));
};

export const parseGasEstimate = (
  value: unknown,
  defaults: {
    paymasterVerificationGasLimit: bigint;
    paymasterPostOpGasLimit: bigint;
  },
): GasEstimate => {
  if (!isObject(value)) {
    throw new Error("Bundler gas estimate is invalid");
  }

  const paymasterVerificationGasLimit = parseOptionalHexQuantity(
    value.paymasterVerificationGasLimit,
    "paymasterVerificationGasLimit",
  );
  const paymasterPostOpGasLimit = parseOptionalHexQuantity(
    value.paymasterPostOpGasLimit,
    "paymasterPostOpGasLimit",
  );

  return {
    callGasLimit: parseHexQuantity(value.callGasLimit, "callGasLimit"),
    verificationGasLimit: parseHexQuantity(value.verificationGasLimit, "verificationGasLimit"),
    preVerificationGas: parseHexQuantity(value.preVerificationGas, "preVerificationGas"),
    paymasterVerificationGasLimit:
      paymasterVerificationGasLimit ?? defaults.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: paymasterPostOpGasLimit ?? defaults.paymasterPostOpGasLimit,
  };
};

const resolveInitCodeFromInput = (userOp: Record<string, unknown>): `0x${string}` => {
  const hasInitCode = userOp.initCode !== undefined && userOp.initCode !== null;
  const hasFactory = userOp.factory !== undefined && userOp.factory !== null;

  if (hasInitCode && hasFactory) {
    throw new Error("Provide either initCode or factory/factoryData, not both");
  }

  if (hasFactory) {
    const factory = parseBytes(userOp.factory, "userOperation.factory");
    if (factory === "0x") {
      return "0x";
    }
    if (factory.length !== 42) {
      throw new Error("userOperation.factory must be a 20-byte address");
    }
    const factoryData = parseBytes(userOp.factoryData ?? "0x", "userOperation.factoryData");
    return `${factory}${factoryData.slice(2)}` as `0x${string}`;
  }

  return parseBytes(userOp.initCode ?? "0x", "userOperation.initCode");
};

export const parseQuoteInput = (input: unknown): ParsedQuoteInput => {
  if (!isObject(input)) {
    throw new Error("Request body must be an object");
  }

  const userOperationRaw = input.userOperation;
  if (!isObject(userOperationRaw)) {
    throw new Error("userOperation is required");
  }

  const sender = normalizeAddress(input.sender ?? userOperationRaw.sender, "sender");
  const entryPoint = normalizeAddress(input.entryPoint, "entryPoint");
  const tokenRaw = String(input.token ?? "USDC").toUpperCase();

  if (tokenRaw !== "USDC") {
    throw new Error("Only USDC is supported");
  }

  const chain = resolveChain(input.chain, input.chainId);

  return {
    sender,
    entryPoint,
    chain,
    token: "USDC",
    userOperation: userOperationRaw,
    userOperationNonce: parseHexQuantity(userOperationRaw.nonce, "userOperation.nonce"),
    initCode: resolveInitCodeFromInput(userOperationRaw),
    callData: parseBytes(userOperationRaw.callData, "userOperation.callData"),
    maxFeePerGas: parseHexQuantity(userOperationRaw.maxFeePerGas, "userOperation.maxFeePerGas"),
    maxPriorityFeePerGas: parseHexQuantity(
      userOperationRaw.maxPriorityFeePerGas,
      "userOperation.maxPriorityFeePerGas",
    ),
  };
};

const toUint128Hex = (value: bigint, fieldName: string): `0x${string}` => {
  if (value < 0n || value > UINT128_MAX) {
    throw new Error(`${fieldName} exceeds uint128`);
  }

  return toHex(value, { size: 16 });
};

export const toBoundedNumber = (value: bigint, maxValue: bigint, fieldName: string): number => {
  if (value < 0n || value > maxValue) {
    throw new Error(`${fieldName} exceeds supported range`);
  }

  return Number(value);
};

export const packUint128Pair = (
  first: bigint,
  second: bigint,
  firstFieldName: string,
  secondFieldName: string,
): `0x${string}` =>
  concatHex([
    toUint128Hex(first, firstFieldName),
    toUint128Hex(second, secondFieldName),
  ]) as `0x${string}`;
