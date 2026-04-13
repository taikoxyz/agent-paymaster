import { createHash } from "node:crypto";

import {
  ADDRESS_PATTERN,
  bigIntToHex,
  type ChainName,
  computeServoPaymasterSigningHash,
  encodeServoErc20PaymasterConfig,
  packPaymasterAndData,
  RPC_INVALID_PARAMS,
  UINT48_MAX,
  WEI_PER_ETH,
  type JsonRpcRequest,
  isJsonRpcFailure,
  isObject,
} from "@agent-paymaster/shared";
import { concatHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { BundlerClient } from "./bundler-client.js";
import {
  CHAIN_CONFIGS,
  type ChainConfig,
  formatUsdcMicros,
  normalizeAddress,
  normalizeOptionalTokenAddresses,
  normalizeSupportedEntryPoints,
  packUint128Pair,
  parseGasEstimate,
  parseQuoteInput,
  toBoundedNumber,
} from "./paymaster-parsing.js";
import type { PriceProvider } from "./price-provider.js";

const QUOTE_ID_LENGTH = 24;
const BPS_SCALE = 10_000n;
const DEFAULT_BILLED_PAYMASTER_VALIDATION_GAS_LIMIT = 50_000n;
const DEFAULT_BILLED_PAYMASTER_POST_OP_GAS = 50_000n;

interface PaymasterCapabilityChain {
  name: ChainName;
  chainId: number;
}

interface PaymasterCapabilityToken {
  symbol: "USDC";
  addresses: Partial<Record<ChainName, string>>;
}

interface PaymasterAllowanceRequirements {
  standard: "EIP-2612";
  spender: "paymaster";
  bootstrap: "bundled-userop";
}

export interface GasPriceGuidance {
  /** Current base fee on the target chain (hex wei). */
  baseFeePerGas: `0x${string}`;
  /** Suggested maxFeePerGas for UserOps (hex wei): 2×baseFee + tip. */
  suggestedMaxFeePerGas: `0x${string}`;
  /** Suggested maxPriorityFeePerGas (hex wei). */
  suggestedMaxPriorityFeePerGas: `0x${string}`;
  /** When this snapshot was taken (ISO-8601). */
  fetchedAt: string;
}

interface PaymasterCapabilities {
  supportedChains: PaymasterCapabilityChain[];
  supportedEntryPoints: string[];
  defaultEntryPoint: string | null;
  supportedTokens: [PaymasterCapabilityToken];
  accountFactoryAddress: string | null;
  allowance: PaymasterAllowanceRequirements;
  gasPriceGuidance?: GasPriceGuidance;
}

/**
 * 65-byte placeholder signature used for gas estimation when the caller has
 * not yet produced a real signature.  The bundler requires a non-empty
 * signature field, so we inject this dummy value for stub/estimation calls.
 */
const DUMMY_SIGNATURE: `0x${string}` =
  "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c";

export class PaymasterRpcError extends Error {
  readonly code: number;
  readonly data?: Record<string, unknown>;

  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "PaymasterRpcError";
    this.code = code;
    this.data = data;
  }
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
  gasPriceGuidance?: GasPriceGuidance;
}

/**
 * Fetches current gas price data from the target chain.  Used to provide
 * agents with a suggested maxFeePerGas so they don't wildly overshoot.
 */
export interface GasPriceOracle {
  getGasPriceGuidance(): Promise<GasPriceGuidance | null>;
}

interface PaymasterServiceConfig {
  paymasterAddress: string;
  quoteTtlSeconds: number;
  surchargeBps: number;
  quoteSignerPrivateKey: `0x${string}`;
  supportedEntryPoints: string[];
  accountFactoryAddress: string | null;
  defaultPaymasterVerificationGasLimit: bigint;
  defaultPaymasterPostOpGasLimit: bigint;
  tokenAddresses: Partial<Record<ChainName, string>>;
  priceProvider: PriceProvider;
  gasPriceOracle?: GasPriceOracle;
}

export type PaymasterServiceConfigInput = Omit<
  Partial<PaymasterServiceConfig>,
  "tokenAddresses" | "priceProvider" | "supportedEntryPoints" | "accountFactoryAddress"
> & {
  supportedEntryPoints?: string[];
  accountFactoryAddress?: string;
  tokenAddresses?: Partial<Record<ChainName, string>>;
  priceProvider?: PriceProvider;
  gasPriceOracle?: GasPriceOracle;
};

const OPERATIONAL_DEFAULTS = {
  quoteTtlSeconds: 90,
  surchargeBps: 500,
  defaultPaymasterVerificationGasLimit: 150_000n,
  defaultPaymasterPostOpGasLimit: 80_000n,
} as const;

const assertSupportedEntryPoint = (entryPoint: string, supportedEntryPoints: string[]): void => {
  if (supportedEntryPoints.includes(entryPoint)) {
    return;
  }

  throw new PaymasterRpcError(RPC_INVALID_PARAMS, "Unsupported entryPoint", {
    reason: "entrypoint_unsupported",
    entryPoint,
    supportedEntryPoints,
  });
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
    const supportedEntryPoints = normalizeSupportedEntryPoints(config.supportedEntryPoints);
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
      supportedEntryPoints,
      accountFactoryAddress:
        config.accountFactoryAddress !== undefined
          ? normalizeAddress(config.accountFactoryAddress, "accountFactoryAddress")
          : null,
      defaultPaymasterVerificationGasLimit:
        config.defaultPaymasterVerificationGasLimit ??
        OPERATIONAL_DEFAULTS.defaultPaymasterVerificationGasLimit,
      defaultPaymasterPostOpGasLimit:
        config.defaultPaymasterPostOpGasLimit ??
        OPERATIONAL_DEFAULTS.defaultPaymasterPostOpGasLimit,
      tokenAddresses: normalizedTokenAddresses,
      priceProvider: config.priceProvider,
      gasPriceOracle: config.gasPriceOracle,
    };

    this.quoteSigner = privateKeyToAccount(this.config.quoteSignerPrivateKey);
  }

  private getSupportedChains(): ChainConfig[] {
    return CHAIN_CONFIGS.filter((chain) => this.config.tokenAddresses[chain.name] !== undefined);
  }

  getConfigSummary(): Record<string, unknown> {
    const supportedChains = this.getSupportedChains();

    return {
      paymasterAddress: this.config.paymasterAddress,
      quoteTtlSeconds: this.config.quoteTtlSeconds,
      supportedChains,
      supportedTokens: ["USDC"],
      supportedEntryPoints: this.config.supportedEntryPoints,
      signerAddress: this.quoteSigner.address,
      priceSource: this.config.priceProvider.describe(),
    };
  }

  getSupportedEntryPoints(): string[] {
    return [...this.config.supportedEntryPoints];
  }

  getChainId(): number {
    const supportedChains = this.getSupportedChains();
    return supportedChains[0]?.chainId ?? CHAIN_CONFIGS[0].chainId;
  }

  async getCapabilities(): Promise<PaymasterCapabilities> {
    const supportedChains = this.getSupportedChains();

    const gasPriceGuidance = this.config.gasPriceOracle
      ? await this.config.gasPriceOracle.getGasPriceGuidance().catch(() => null)
      : null;

    return {
      supportedChains,
      supportedEntryPoints: this.getSupportedEntryPoints(),
      defaultEntryPoint: this.config.supportedEntryPoints[0] ?? null,
      supportedTokens: [
        {
          symbol: "USDC",
          addresses: { ...this.config.tokenAddresses },
        },
      ],
      accountFactoryAddress: this.config.accountFactoryAddress,
      allowance: {
        standard: "EIP-2612",
        spender: "paymaster",
        bootstrap: "bundled-userop",
      },
      ...(gasPriceGuidance !== null ? { gasPriceGuidance } : {}),
    };
  }

  validateUserOperationEntryPoint(entryPoint: unknown, method: string): string {
    if (typeof entryPoint !== "string" || !ADDRESS_PATTERN.test(entryPoint)) {
      throw new PaymasterRpcError(RPC_INVALID_PARAMS, "Invalid entryPoint", {
        reason: "entrypoint_invalid",
        method,
      });
    }

    const normalizedEntryPoint = entryPoint.toLowerCase();
    assertSupportedEntryPoint(normalizedEntryPoint, this.config.supportedEntryPoints);
    return normalizedEntryPoint;
  }

  async quote(input: unknown): Promise<PaymasterQuote> {
    const parsed = parseQuoteInput(input);
    assertSupportedEntryPoint(parsed.entryPoint, this.config.supportedEntryPoints);
    const tokenAddress = this.config.tokenAddresses[parsed.chain.name];

    if (tokenAddress === undefined) {
      throw new Error(`Chain ${parsed.chain.name} is not configured`);
    }

    // Normalize deployment fields to packed initCode before forwarding to the
    // bundler so v0.7 factory/factoryData callers don't become ambiguous when
    // we inject estimation defaults.
    const estimationUserOpBase: Record<string, unknown> = { ...parsed.userOperation };
    delete estimationUserOpBase.factory;
    delete estimationUserOpBase.factoryData;
    const estimationUserOp = {
      ...estimationUserOpBase,
      initCode: parsed.initCode,
      signature:
        parsed.userOperation.signature && parsed.userOperation.signature !== "0x"
          ? parsed.userOperation.signature
          : DUMMY_SIGNATURE,
    };

    const gasEstimateResponse = await this.bundlerClient.rpc({
      jsonrpc: "2.0",
      id: "pm-estimate",
      method: "eth_estimateUserOperationGas",
      params: [estimationUserOp, parsed.entryPoint],
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
    const marketRate = await this.config.priceProvider.getUsdcPerEthMicros(parsed.chain.name);
    if (marketRate <= 0n) {
      throw new Error("priceProvider returned a non-positive exchange rate");
    }

    // Pimlico's SingletonPaymasterV7 has no percentage-surcharge field; Servo bakes its margin into
    // the signed exchangeRate by multiplying the market rate by (1 + surchargeBps/10000). Ceiling
    // division ensures the paymaster never under-collects.
    const surchargedRate =
      (marketRate * (BPS_SCALE + BigInt(this.config.surchargeBps)) + (BPS_SCALE - 1n)) / BPS_SCALE;
    const exchangeRate = surchargedRate;

    const maxTokenCostMicros = (estimatedGasWei * exchangeRate) / WEI_PER_ETH;
    const boundedMaxTokenCostMicros = maxTokenCostMicros > 0n ? maxTokenCostMicros : 1n;

    const VALID_AFTER_GRACE_SECONDS = 30;
    const nowSeconds = Math.floor(this.nowMs() / 1000);
    const validAfterSeconds = nowSeconds - VALID_AFTER_GRACE_SECONDS;
    const validUntilSeconds = nowSeconds + this.config.quoteTtlSeconds;

    const accountGasLimits = packUint128Pair(
      gas.verificationGasLimit,
      gas.callGasLimit,
      "verificationGasLimit",
      "callGasLimit",
    );
    const gasFees = packUint128Pair(
      parsed.maxPriorityFeePerGas,
      parsed.maxFeePerGas,
      "maxPriorityFeePerGas",
      "maxFeePerGas",
    );
    const billedPaymasterValidationGasLimit =
      gas.paymasterVerificationGasLimit < DEFAULT_BILLED_PAYMASTER_VALIDATION_GAS_LIMIT
        ? gas.paymasterVerificationGasLimit
        : DEFAULT_BILLED_PAYMASTER_VALIDATION_GAS_LIMIT;
    const billedPaymasterPostOpGas =
      gas.paymasterPostOpGasLimit < DEFAULT_BILLED_PAYMASTER_POST_OP_GAS
        ? gas.paymasterPostOpGasLimit
        : DEFAULT_BILLED_PAYMASTER_POST_OP_GAS;

    // Build the inner ERC-20 mode paymasterConfig bytes. The outer gas fields remain conservative
    // execution caps, but Servo bills against smaller fixed inner values to avoid overcharging in
    // token settlement. The paymaster pools funds on itself, so treasury = paymasterAddress.
    const erc20ConfigBytes = encodeServoErc20PaymasterConfig({
      validUntil: toBoundedNumber(BigInt(validUntilSeconds), UINT48_MAX, "validUntil"),
      validAfter: toBoundedNumber(BigInt(validAfterSeconds), UINT48_MAX, "validAfter"),
      token: tokenAddress as `0x${string}`,
      postOpGas: billedPaymasterPostOpGas,
      exchangeRate,
      paymasterValidationGasLimit: billedPaymasterValidationGasLimit,
      treasury: this.config.paymasterAddress as `0x${string}`,
    });

    // The "paymasterAndData-without-signature" buffer that Pimlico hashes over. 170 bytes: 52 bytes
    // of outer envelope (paymaster + vGas + pmPostOpGas) + 118 bytes of inner config.
    const paymasterAndDataNoSig = packPaymasterAndData({
      paymaster: this.config.paymasterAddress as `0x${string}`,
      paymasterVerificationGasLimit: gas.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: gas.paymasterPostOpGasLimit,
      paymasterData: erc20ConfigBytes,
    });

    const signingHash = computeServoPaymasterSigningHash({
      userOp: {
        sender: parsed.sender as `0x${string}`,
        nonce: parsed.userOperationNonce,
        initCode: parsed.initCode,
        callData: parsed.callData,
        accountGasLimits,
        preVerificationGas: gas.preVerificationGas,
        gasFees,
      },
      paymasterAndDataNoSig,
      chainId: parsed.chain.chainId,
    });

    // personal_sign (EIP-191) — MessageHashUtils.toEthSignedMessageHash on-chain matches
    // signMessage({ raw: hash }) off-chain.
    const quoteSignature = (await this.quoteSigner.signMessage({
      message: { raw: signingHash },
    })) as `0x${string}`;

    // Final paymasterData = inner ERC-20 config + signature. The outer envelope is already part of
    // paymasterAndDataNoSig; append the signature to form the full paymasterAndData.
    const paymasterData = concatHex([erc20ConfigBytes, quoteSignature]) as `0x${string}`;
    const paymasterAndData = concatHex([paymasterAndDataNoSig, quoteSignature]) as `0x${string}`;

    const quoteId = createHash("sha256")
      .update(paymasterData.slice(2))
      .digest("hex")
      .slice(0, QUOTE_ID_LENGTH);

    const gasPriceGuidance = this.config.gasPriceOracle
      ? await this.config.gasPriceOracle.getGasPriceGuidance().catch(() => null)
      : null;

    return {
      quoteId,
      chain: parsed.chain.name,
      chainId: parsed.chain.chainId,
      token: parsed.token,
      paymaster: this.config.paymasterAddress,
      paymasterData,
      paymasterAndData,
      callGasLimit: bigIntToHex(gas.callGasLimit),
      verificationGasLimit: bigIntToHex(gas.verificationGasLimit),
      preVerificationGas: bigIntToHex(gas.preVerificationGas),
      paymasterVerificationGasLimit: bigIntToHex(gas.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: bigIntToHex(gas.paymasterPostOpGasLimit),
      estimatedGasLimit: bigIntToHex(totalGasLimit),
      estimatedGasWei: bigIntToHex(estimatedGasWei),
      maxTokenCostMicros: boundedMaxTokenCostMicros.toString(),
      maxTokenCost: formatUsdcMicros(boundedMaxTokenCostMicros),
      validUntil: validUntilSeconds,
      entryPoint: parsed.entryPoint,
      sender: parsed.sender,
      tokenAddress,
      ...(gasPriceGuidance !== null ? { gasPriceGuidance } : {}),
    };
  }

  async handleRpc(method: string, params: unknown): Promise<unknown> {
    if (method === "pm_supportedEntryPoints") {
      return this.getSupportedEntryPoints();
    }

    if (method === "pm_getCapabilities") {
      return await this.getCapabilities();
    }

    if (method !== "pm_getPaymasterData" && method !== "pm_getPaymasterStubData") {
      throw new Error(`Unsupported paymaster method: ${method}`);
    }

    if (!Array.isArray(params) || params.length < 2) {
      throw new PaymasterRpcError(
        RPC_INVALID_PARAMS,
        "Paymaster RPC params must be [userOperation, entryPoint, chain]",
        {
          reason: "params_invalid",
          method,
        },
      );
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
      ...(quote.gasPriceGuidance !== undefined ? { gasPriceGuidance: quote.gasPriceGuidance } : {}),
    };
  }
}
