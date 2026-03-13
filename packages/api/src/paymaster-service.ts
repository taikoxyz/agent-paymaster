import { createHash } from "node:crypto";

import { concatHex, encodeAbiParameters, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { BundlerClient } from "./bundler-client.js";
import { type JsonRpcRequest, isJsonRpcFailure, isObject } from "./types.js";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HEX_QUANTITY_PATTERN = /^0x[0-9a-fA-F]+$/;
const HEX_BYTES_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const WEI_PER_ETH = 10n ** 18n;
const QUOTE_ID_LENGTH = 24;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT48_MAX = (1n << 48n) - 1n;
const UINT32_MAX = (1n << 32n) - 1n;
const UINT16_MAX = (1n << 16n) - 1n;

const PAYMASTER_DATA_PARAMETERS = [
  {
    type: "tuple",
    name: "quote",
    components: [
      { name: "token", type: "address" },
      { name: "exchangeRate", type: "uint256" },
      { name: "maxTokenCost", type: "uint256" },
      { name: "validAfter", type: "uint48" },
      { name: "validUntil", type: "uint48" },
      { name: "postOpOverheadGas", type: "uint32" },
      { name: "surchargeBps", type: "uint16" },
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
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

const SPONSORED_USER_OPERATION_TYPES = {
  SponsoredUserOperation: [
    { name: "sender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "initCodeHash", type: "bytes32" },
    { name: "callDataHash", type: "bytes32" },
    { name: "accountGasLimits", type: "bytes32" },
    { name: "paymasterGasLimits", type: "bytes32" },
    { name: "preVerificationGas", type: "uint256" },
    { name: "gasFees", type: "bytes32" },
    { name: "token", type: "address" },
    { name: "exchangeRate", type: "uint256" },
    { name: "maxTokenCost", type: "uint256" },
    { name: "validAfter", type: "uint48" },
    { name: "validUntil", type: "uint48" },
    { name: "postOpOverheadGas", type: "uint32" },
    { name: "surchargeBps", type: "uint16" },
    { name: "chainId", type: "uint256" },
    { name: "paymaster", type: "address" },
  ],
} as const;

interface QuoteData {
  token: `0x${string}`;
  exchangeRate: bigint;
  maxTokenCost: bigint;
  validAfter: number;
  validUntil: number;
  postOpOverheadGas: number;
  surchargeBps: number;
}

interface PermitData {
  value: bigint;
  deadline: bigint;
  signature: `0x${string}`;
}

interface SponsoredUserOperationMessage {
  sender: `0x${string}`;
  nonce: bigint;
  initCodeHash: `0x${string}`;
  callDataHash: `0x${string}`;
  accountGasLimits: `0x${string}`;
  paymasterGasLimits: `0x${string}`;
  preVerificationGas: bigint;
  gasFees: `0x${string}`;
  token: `0x${string}`;
  exchangeRate: bigint;
  maxTokenCost: bigint;
  validAfter: number;
  validUntil: number;
  postOpOverheadGas: number;
  surchargeBps: number;
  chainId: bigint;
  paymaster: `0x${string}`;
}

const EMPTY_PERMIT: PermitData = {
  value: 0n,
  deadline: 0n,
  signature: "0x",
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
  initCode: `0x${string}`;
  callData: `0x${string}`;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface PaymasterQuote {
  quoteId: string;
  chain: ChainName;
  chainId: number;
  token: "USDC";
  paymaster: string;
  paymasterData: `0x${string}`;
  paymasterAndData: `0x${string}`;
  callGasLimit: `0x${string}`;
  verificationGasLimit: `0x${string}`;
  preVerificationGas: `0x${string}`;
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

export interface PriceProvider {
  getUsdcPerEthMicros(chain: ChainName): bigint | Promise<bigint>;
  describe(): string;
}

export class StaticPriceProvider implements PriceProvider {
  private readonly usdcPerEthMicros: bigint;

  constructor(usdcPerEthMicros: bigint) {
    if (usdcPerEthMicros <= 0n) {
      throw new Error("Static price provider requires a positive usdcPerEthMicros value");
    }

    this.usdcPerEthMicros = usdcPerEthMicros;
  }

  getUsdcPerEthMicros(): bigint {
    return this.usdcPerEthMicros;
  }

  describe(): string {
    return "static";
  }
}

export interface PaymasterServiceConfig {
  paymasterAddress: string;
  quoteTtlSeconds: number;
  surchargeBps: number;
  quoteSignerPrivateKey: `0x${string}`;
  defaultPaymasterVerificationGasLimit: bigint;
  defaultPaymasterPostOpGasLimit: bigint;
  tokenAddresses: Partial<Record<ChainName, string>>;
  priceProvider: PriceProvider;
}

export type PaymasterServiceConfigInput = Omit<
  Partial<PaymasterServiceConfig>,
  "tokenAddresses" | "priceProvider"
> & {
  tokenAddresses?: Partial<Record<ChainName, string>>;
  priceProvider?: PriceProvider;
};

const OPERATIONAL_DEFAULTS = {
  quoteTtlSeconds: 90,
  surchargeBps: 500,
  defaultPaymasterVerificationGasLimit: 60_000n,
  defaultPaymasterPostOpGasLimit: 45_000n,
} as const;

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

const normalizeOptionalTokenAddresses = (
  tokenAddresses: Partial<Record<ChainName, string>>,
): Partial<Record<ChainName, string>> => {
  const normalized: Partial<Record<ChainName, string>> = {};

  if (tokenAddresses.taikoMainnet !== undefined) {
    normalized.taikoMainnet = normalizeAddress(
      tokenAddresses.taikoMainnet,
      "tokenAddresses.taikoMainnet",
    );
  }

  if (tokenAddresses.taikoHekla !== undefined) {
    normalized.taikoHekla = normalizeAddress(
      tokenAddresses.taikoHekla,
      "tokenAddresses.taikoHekla",
    );
  }

  if (tokenAddresses.taikoHoodi !== undefined) {
    normalized.taikoHoodi = normalizeAddress(
      tokenAddresses.taikoHoodi,
      "tokenAddresses.taikoHoodi",
    );
  }

  return normalized;
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

  return {
    sender,
    entryPoint,
    chain,
    token: "USDC",
    userOperation: userOperationRaw,
    userOperationNonce: parseHexQuantity(userOperationRaw.nonce, "userOperation.nonce"),
    initCode: parseBytes(userOperationRaw.initCode ?? "0x", "userOperation.initCode"),
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

const toBoundedNumber = (value: bigint, maxValue: bigint, fieldName: string): number => {
  if (value < 0n || value > maxValue) {
    throw new Error(`${fieldName} exceeds supported range`);
  }

  return Number(value);
};

const packUint128Pair = (
  first: bigint,
  second: bigint,
  firstFieldName: string,
  secondFieldName: string,
): `0x${string}` =>
  concatHex([
    toUint128Hex(first, firstFieldName),
    toUint128Hex(second, secondFieldName),
  ]) as `0x${string}`;

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

    const tokenAddresses = config.tokenAddresses ?? {};
    const quoteSignerPrivateKey = config.quoteSignerPrivateKey;

    if (
      typeof quoteSignerPrivateKey !== "string" ||
      !/^0x[a-fA-F0-9]{64}$/u.test(quoteSignerPrivateKey)
    ) {
      throw new Error("quoteSignerPrivateKey must be a 32-byte hex private key");
    }

    if (!config.paymasterAddress) {
      throw new Error("paymasterAddress is required");
    }

    if (config.priceProvider === undefined) {
      throw new Error("priceProvider is required");
    }

    const normalizedTokenAddresses = normalizeOptionalTokenAddresses(tokenAddresses);
    if (Object.keys(normalizedTokenAddresses).length === 0) {
      throw new Error("At least one chain token address must be configured");
    }

    const surchargeBps = Math.max(0, config.surchargeBps ?? OPERATIONAL_DEFAULTS.surchargeBps);
    if (surchargeBps > 10_000) {
      throw new Error("surchargeBps must be between 0 and 10000");
    }

    this.config = {
      paymasterAddress: normalizeAddress(config.paymasterAddress, "paymasterAddress"),
      quoteTtlSeconds: Math.max(15, config.quoteTtlSeconds ?? OPERATIONAL_DEFAULTS.quoteTtlSeconds),
      surchargeBps,
      quoteSignerPrivateKey,
      defaultPaymasterVerificationGasLimit:
        config.defaultPaymasterVerificationGasLimit ??
        OPERATIONAL_DEFAULTS.defaultPaymasterVerificationGasLimit,
      defaultPaymasterPostOpGasLimit:
        config.defaultPaymasterPostOpGasLimit ??
        OPERATIONAL_DEFAULTS.defaultPaymasterPostOpGasLimit,
      tokenAddresses: normalizedTokenAddresses,
      priceProvider: config.priceProvider,
    };

    this.quoteSigner = privateKeyToAccount(this.config.quoteSignerPrivateKey);
  }

  getConfigSummary(): Record<string, unknown> {
    const supportedChains = CHAIN_CONFIGS.filter(
      (chain) => this.config.tokenAddresses[chain.name] !== undefined,
    );

    return {
      paymasterAddress: this.config.paymasterAddress,
      quoteTtlSeconds: this.config.quoteTtlSeconds,
      supportedChains,
      supportedTokens: ["USDC"],
      signerAddress: this.quoteSigner.address,
      priceSource: this.config.priceProvider.describe(),
    };
  }

  buildQuoteRequestKey(input: unknown): string {
    const parsed = parseQuoteInput(input);

    const stablePayload = {
      sender: parsed.sender,
      entryPoint: parsed.entryPoint,
      chainId: parsed.chain.chainId,
      token: parsed.token,
      userOperation: {
        nonce: parsed.userOperationNonce.toString(),
        initCode: parsed.initCode,
        callData: parsed.callData,
        maxFeePerGas: parsed.maxFeePerGas.toString(),
        maxPriorityFeePerGas: parsed.maxPriorityFeePerGas.toString(),
        l1DataGas: String(parsed.userOperation.l1DataGas ?? "0x"),
      },
    };

    return createHash("sha256").update(JSON.stringify(stablePayload)).digest("hex");
  }

  async quote(input: unknown): Promise<PaymasterQuote> {
    const parsed = parseQuoteInput(input);
    const tokenAddress = this.config.tokenAddresses[parsed.chain.name];

    if (tokenAddress === undefined) {
      throw new Error(`Chain ${parsed.chain.name} is not configured`);
    }

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

    const totalGasLimit =
      gas.callGasLimit +
      gas.verificationGasLimit +
      gas.preVerificationGas +
      gas.paymasterVerificationGasLimit +
      gas.paymasterPostOpGasLimit;

    const estimatedGasWei = totalGasLimit * parsed.maxFeePerGas;
    const exchangeRate = await this.config.priceProvider.getUsdcPerEthMicros(parsed.chain.name);
    if (exchangeRate <= 0n) {
      throw new Error("priceProvider returned a non-positive exchange rate");
    }

    const baseMicros = (estimatedGasWei * exchangeRate) / WEI_PER_ETH;
    const grossMicros =
      (baseMicros * BigInt(10_000 + this.config.surchargeBps) + BigInt(10_000 - 1)) /
      BigInt(10_000);
    const maxTokenCostMicros = grossMicros > 0n ? grossMicros : 1n;

    const validAfterSeconds = Math.floor(this.nowMs() / 1000);
    const validUntilSeconds = validAfterSeconds + this.config.quoteTtlSeconds;

    const accountGasLimits = packUint128Pair(
      gas.verificationGasLimit,
      gas.callGasLimit,
      "verificationGasLimit",
      "callGasLimit",
    );
    const paymasterGasLimits = packUint128Pair(
      gas.paymasterVerificationGasLimit,
      gas.paymasterPostOpGasLimit,
      "paymasterVerificationGasLimit",
      "paymasterPostOpGasLimit",
    );
    const gasFees = packUint128Pair(
      parsed.maxPriorityFeePerGas,
      parsed.maxFeePerGas,
      "maxPriorityFeePerGas",
      "maxFeePerGas",
    );

    const quoteData: QuoteData = {
      token: tokenAddress as `0x${string}`,
      exchangeRate,
      maxTokenCost: maxTokenCostMicros,
      validAfter: toBoundedNumber(BigInt(validAfterSeconds), UINT48_MAX, "validAfter"),
      validUntil: toBoundedNumber(BigInt(validUntilSeconds), UINT48_MAX, "validUntil"),
      postOpOverheadGas: toBoundedNumber(
        gas.paymasterPostOpGasLimit,
        UINT32_MAX,
        "postOpOverheadGas",
      ),
      surchargeBps: toBoundedNumber(BigInt(this.config.surchargeBps), UINT16_MAX, "surchargeBps"),
    };

    const message: SponsoredUserOperationMessage = {
      sender: parsed.sender as `0x${string}`,
      nonce: parsed.userOperationNonce,
      initCodeHash: keccak256(parsed.initCode),
      callDataHash: keccak256(parsed.callData),
      accountGasLimits,
      paymasterGasLimits,
      preVerificationGas: gas.preVerificationGas,
      gasFees,
      token: quoteData.token,
      exchangeRate: quoteData.exchangeRate,
      maxTokenCost: quoteData.maxTokenCost,
      validAfter: quoteData.validAfter,
      validUntil: quoteData.validUntil,
      postOpOverheadGas: quoteData.postOpOverheadGas,
      surchargeBps: quoteData.surchargeBps,
      chainId: BigInt(parsed.chain.chainId),
      paymaster: this.config.paymasterAddress as `0x${string}`,
    };

    const quoteSignature = await this.quoteSigner.signTypedData({
      domain: {
        name: "TaikoUsdcPaymaster",
        version: "3",
        chainId: BigInt(parsed.chain.chainId),
        verifyingContract: this.config.paymasterAddress as `0x${string}`,
      },
      types: SPONSORED_USER_OPERATION_TYPES,
      primaryType: "SponsoredUserOperation",
      message,
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
      callGasLimit: toHexQuantity(gas.callGasLimit),
      verificationGasLimit: toHexQuantity(gas.verificationGasLimit),
      preVerificationGas: toHexQuantity(gas.preVerificationGas),
      paymasterVerificationGasLimit: toHexQuantity(gas.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: toHexQuantity(gas.paymasterPostOpGasLimit),
      estimatedGasLimit: toHexQuantity(totalGasLimit),
      estimatedGasWei: toHexQuantity(estimatedGasWei),
      maxTokenCostMicros: maxTokenCostMicros.toString(),
      maxTokenCost: formatUsdcMicros(maxTokenCostMicros),
      validUntil: validUntilSeconds,
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
      callGasLimit: quote.callGasLimit,
      verificationGasLimit: quote.verificationGasLimit,
      preVerificationGas: quote.preVerificationGas,
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
