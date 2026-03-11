import { createHash } from "node:crypto";

import { encodeAbiParameters, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { BundlerClient } from "./bundler-client.js";
import { type JsonRpcRequest, isJsonRpcFailure, isObject } from "./types.js";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HEX_QUANTITY_PATTERN = /^0x[0-9a-fA-F]+$/;
const HEX_BYTES_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const WEI_PER_ETH = 10n ** 18n;
const ZERO_BYTES32 = `0x${"0".repeat(64)}` as const;
const QUOTE_ID_LENGTH = 24;
const PAYMASTER_DATA_PARAMETERS = [
  {
    type: "tuple",
    name: "quote",
    components: [
      { name: "sender", type: "address" },
      { name: "token", type: "address" },
      { name: "entryPoint", type: "address" },
      { name: "chainId", type: "uint256" },
      { name: "maxTokenCost", type: "uint256" },
      { name: "validAfter", type: "uint48" },
      { name: "validUntil", type: "uint48" },
      { name: "nonce", type: "uint256" },
      { name: "callDataHash", type: "bytes32" },
    ],
  },
  {
    type: "bytes",
    name: "quoteSignature",
  },
  {
    type: "tuple",
    name: "permit",
    components: [
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
  },
] as const;

const QUOTE_TYPES = {
  QuoteData: [
    { name: "sender", type: "address" },
    { name: "token", type: "address" },
    { name: "entryPoint", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "maxTokenCost", type: "uint256" },
    { name: "validAfter", type: "uint48" },
    { name: "validUntil", type: "uint48" },
    { name: "nonce", type: "uint256" },
    { name: "callDataHash", type: "bytes32" },
  ],
} as const;

interface QuoteData {
  sender: `0x${string}`;
  token: `0x${string}`;
  entryPoint: `0x${string}`;
  chainId: bigint;
  maxTokenCost: bigint;
  validAfter: number;
  validUntil: number;
  nonce: bigint;
  callDataHash: `0x${string}`;
}

interface PermitData {
  value: bigint;
  deadline: bigint;
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

const EMPTY_PERMIT: PermitData = {
  value: 0n,
  deadline: 0n,
  v: 0,
  r: ZERO_BYTES32,
  s: ZERO_BYTES32,
};

export type ChainName = "taikoMainnet" | "taikoHekla" | "taikoHoodi";

interface ChainConfig {
  name: ChainName;
  chainId: number;
}

const CHAIN_CONFIGS: ChainConfig[] = [
  { name: "taikoMainnet", chainId: 167000 },
  { name: "taikoHekla", chainId: 167009 },
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
  callData: `0x${string}`;
}

export interface PaymasterQuote {
  quoteId: string;
  chain: ChainName;
  chainId: number;
  token: "USDC";
  paymaster: string;
  paymasterData: `0x${string}`;
  paymasterAndData: `0x${string}`;
  paymasterVerificationGasLimit: `0x${string}`;
  paymasterPostOpGasLimit: `0x${string}`;
  estimatedGasLimit: `0x${string}`;
  estimatedGasWei: `0x${string}`;
  maxTokenCostMicros: string;
  maxTokenCost: string;
  validUntil: number;
  entryPoint: string;
  sender: string;
  tokenAddress: string;
}

export interface PaymasterServiceConfig {
  paymasterAddress: string;
  quoteTtlSeconds: number;
  usdcPerEthMicros: bigint;
  surchargeBps: number;
  quoteSignerPrivateKey: `0x${string}`;
  defaultPaymasterVerificationGasLimit: bigint;
  defaultPaymasterPostOpGasLimit: bigint;
  tokenAddresses: Record<ChainName, string>;
}

export type PaymasterServiceConfigInput = Omit<
  Partial<PaymasterServiceConfig>,
  "tokenAddresses"
> & {
  tokenAddresses?: Partial<Record<ChainName, string>>;
};

export const DEFAULT_PAYMASTER_CONFIG: PaymasterServiceConfig = {
  paymasterAddress: "0x9999999999999999999999999999999999999999",
  quoteTtlSeconds: 90,
  usdcPerEthMicros: 0n,
  surchargeBps: 500,
  quoteSignerPrivateKey: `0x${"1".repeat(64)}`,
  defaultPaymasterVerificationGasLimit: 60_000n,
  defaultPaymasterPostOpGasLimit: 45_000n,
  tokenAddresses: {
    taikoMainnet: "0x07d83526730c7438048d55a4fc0b850e2aab6f0b",
    taikoHekla: "0x07d83526730c7438048d55a4fc0b850e2aab6f0b",
    taikoHoodi: "0x07d83526730c7438048d55a4fc0b850e2aab6f0b",
  },
};

const normalizeAddress = (value: unknown, fieldName: string): string => {
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

const toHexQuantity = (value: bigint): `0x${string}` => {
  if (value < 0n) {
    throw new Error("Negative values are not supported");
  }

  return `0x${value.toString(16)}`;
};

const formatUsdcMicros = (microsInput: bigint): string => {
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

  throw new Error("Unsupported chain. Supported values: taikoMainnet, taikoHekla, taikoHoodi");
};

const parseGasEstimate = (
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

const parseQuoteInput = (input: unknown): ParsedQuoteInput => {
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
  const userOperationNonce = parseHexQuantity(userOperationRaw.nonce, "userOperation.nonce");
  const callData = parseBytes(userOperationRaw.callData, "userOperation.callData");

  return {
    sender,
    entryPoint,
    chain,
    token: "USDC",
    userOperation: userOperationRaw,
    userOperationNonce,
    callData,
  };
};

export class PaymasterService {
  private readonly bundlerClient: BundlerClient;
  private readonly config: PaymasterServiceConfig;
  private readonly nowMs: () => number;
  private readonly quoteSigner: ReturnType<typeof privateKeyToAccount>;

  constructor(
    bundlerClient: BundlerClient,
    config: PaymasterServiceConfigInput = {},
    nowMs: () => number = () => Date.now(),
  ) {
    this.bundlerClient = bundlerClient;
    this.nowMs = nowMs;

    const merged = {
      ...DEFAULT_PAYMASTER_CONFIG,
      ...config,
      tokenAddresses: {
        ...DEFAULT_PAYMASTER_CONFIG.tokenAddresses,
        ...(config.tokenAddresses ?? {}),
      },
    };

    const paymasterAddress = merged.paymasterAddress ?? DEFAULT_PAYMASTER_CONFIG.paymasterAddress;
    const tokenAddressMainnet =
      merged.tokenAddresses.taikoMainnet ?? DEFAULT_PAYMASTER_CONFIG.tokenAddresses.taikoMainnet;
    const tokenAddressHekla =
      merged.tokenAddresses.taikoHekla ?? DEFAULT_PAYMASTER_CONFIG.tokenAddresses.taikoHekla;
    const tokenAddressHoodi =
      merged.tokenAddresses.taikoHoodi ?? DEFAULT_PAYMASTER_CONFIG.tokenAddresses.taikoHoodi;
    const quoteSignerPrivateKey =
      merged.quoteSignerPrivateKey ?? DEFAULT_PAYMASTER_CONFIG.quoteSignerPrivateKey;

    if (
      typeof quoteSignerPrivateKey !== "string" ||
      !/^0x[a-fA-F0-9]{64}$/u.test(quoteSignerPrivateKey)
    ) {
      throw new Error("quoteSignerPrivateKey must be a 32-byte hex private key");
    }

    this.config = {
      ...merged,
      paymasterAddress: normalizeAddress(paymasterAddress, "paymasterAddress"),
      quoteTtlSeconds: Math.max(15, merged.quoteTtlSeconds),
      surchargeBps: Math.max(0, merged.surchargeBps),
      quoteSignerPrivateKey,
      defaultPaymasterVerificationGasLimit: merged.defaultPaymasterVerificationGasLimit,
      defaultPaymasterPostOpGasLimit: merged.defaultPaymasterPostOpGasLimit,
      tokenAddresses: {
        taikoMainnet: normalizeAddress(tokenAddressMainnet, "tokenAddresses.taikoMainnet"),
        taikoHekla: normalizeAddress(tokenAddressHekla, "tokenAddresses.taikoHekla"),
        taikoHoodi: normalizeAddress(tokenAddressHoodi, "tokenAddresses.taikoHoodi"),
      },
      usdcPerEthMicros:
        merged.usdcPerEthMicros > 0n
          ? merged.usdcPerEthMicros
          : DEFAULT_PAYMASTER_CONFIG.usdcPerEthMicros,
    };

    if (this.config.usdcPerEthMicros <= 0n) {
      throw new Error("usdcPerEthMicros must be configured and greater than zero");
    }

    this.quoteSigner = privateKeyToAccount(this.config.quoteSignerPrivateKey);
  }

  getConfigSummary(): Record<string, unknown> {
    return {
      paymasterAddress: this.config.paymasterAddress,
      quoteTtlSeconds: this.config.quoteTtlSeconds,
      supportedChains: CHAIN_CONFIGS,
      supportedTokens: ["USDC"],
      signerAddress: this.quoteSigner.address,
    };
  }

  async quote(input: unknown): Promise<PaymasterQuote> {
    const parsed = parseQuoteInput(input);

    const gasEstimateResponse = await this.bundlerClient.rpc({
      jsonrpc: "2.0",
      id: "pm-estimate",
      method: "eth_estimateUserOperationGas",
      params: [parsed.userOperation, parsed.entryPoint],
    } satisfies JsonRpcRequest);

    if (isJsonRpcFailure(gasEstimateResponse)) {
      throw new Error(`Bundler gas estimate failed: ${gasEstimateResponse.error.message}`);
    }

    const gas = parseGasEstimate(gasEstimateResponse.result, {
      paymasterVerificationGasLimit: this.config.defaultPaymasterVerificationGasLimit,
      paymasterPostOpGasLimit: this.config.defaultPaymasterPostOpGasLimit,
    });
    const userOpMaxFeePerGas = parseHexQuantity(
      parsed.userOperation.maxFeePerGas,
      "userOperation.maxFeePerGas",
    );

    const totalGasLimit =
      gas.callGasLimit +
      gas.verificationGasLimit +
      gas.preVerificationGas +
      gas.paymasterVerificationGasLimit +
      gas.paymasterPostOpGasLimit;

    const estimatedGasWei = totalGasLimit * userOpMaxFeePerGas;

    const baseMicros = (estimatedGasWei * this.config.usdcPerEthMicros) / WEI_PER_ETH;
    const grossMicros =
      (baseMicros * BigInt(10_000 + this.config.surchargeBps) + BigInt(10_000 - 1)) /
      BigInt(10_000);
    const maxTokenCostMicros = grossMicros > 0n ? grossMicros : 1n;

    const tokenAddress = this.config.tokenAddresses[parsed.chain.name];
    const validAfter = Math.floor(this.nowMs() / 1000);
    const validUntil = validAfter + this.config.quoteTtlSeconds;
    const callDataHash = keccak256(parsed.callData);

    const quoteData: QuoteData = {
      sender: parsed.sender as `0x${string}`,
      token: tokenAddress as `0x${string}`,
      entryPoint: parsed.entryPoint as `0x${string}`,
      chainId: BigInt(parsed.chain.chainId),
      maxTokenCost: maxTokenCostMicros,
      validAfter,
      validUntil,
      nonce: parsed.userOperationNonce,
      callDataHash,
    };

    const quoteSignature = await this.quoteSigner.signTypedData({
      domain: {
        name: "TaikoUsdcPaymaster",
        version: "1",
        chainId: quoteData.chainId,
        verifyingContract: this.config.paymasterAddress as `0x${string}`,
      },
      types: QUOTE_TYPES,
      primaryType: "QuoteData",
      message: quoteData,
    });

    const paymasterData = encodeAbiParameters(PAYMASTER_DATA_PARAMETERS, [
      quoteData,
      quoteSignature,
      EMPTY_PERMIT,
    ]) as `0x${string}`;

    const quoteId = createHash("sha256")
      .update(paymasterData.slice(2))
      .digest("hex")
      .slice(0, QUOTE_ID_LENGTH);
    const paymasterAndData =
      `${this.config.paymasterAddress}${paymasterData.slice(2)}` as `0x${string}`;

    return {
      quoteId,
      chain: parsed.chain.name,
      chainId: parsed.chain.chainId,
      token: parsed.token,
      paymaster: this.config.paymasterAddress,
      paymasterData,
      paymasterAndData,
      paymasterVerificationGasLimit: toHexQuantity(gas.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: toHexQuantity(gas.paymasterPostOpGasLimit),
      estimatedGasLimit: toHexQuantity(totalGasLimit),
      estimatedGasWei: toHexQuantity(estimatedGasWei),
      maxTokenCostMicros: maxTokenCostMicros.toString(),
      maxTokenCost: formatUsdcMicros(maxTokenCostMicros),
      validUntil,
      entryPoint: parsed.entryPoint,
      sender: parsed.sender,
      tokenAddress,
    };
  }

  async handleRpc(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (method !== "pm_getPaymasterData" && method !== "pm_getPaymasterStubData") {
      throw new Error(`Unsupported paymaster method: ${method}`);
    }

    if (!Array.isArray(params) || params.length < 2) {
      throw new Error("Paymaster RPC params must be [userOperation, entryPoint, chain]");
    }

    const [userOperation, entryPoint, chainMaybe] = params;

    const quote = await this.quote({
      userOperation,
      sender: isObject(userOperation) ? userOperation.sender : undefined,
      entryPoint,
      chain: chainMaybe,
      token: "USDC",
    });

    return {
      paymaster: quote.paymaster,
      paymasterData: quote.paymasterData,
      paymasterAndData: quote.paymasterAndData,
      paymasterVerificationGasLimit: quote.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: quote.paymasterPostOpGasLimit,
      quoteId: quote.quoteId,
      token: quote.token,
      tokenAddress: quote.tokenAddress,
      maxTokenCost: quote.maxTokenCost,
      maxTokenCostMicros: quote.maxTokenCostMicros,
      validUntil: quote.validUntil,
      isStub: method === "pm_getPaymasterStubData",
    };
  }
}
