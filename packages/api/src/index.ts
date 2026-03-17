import { randomUUID } from "node:crypto";

import { buildHealth } from "@agent-paymaster/shared";
import { Hono } from "hono";

import { type BundlerClient, HttpBundlerClient } from "./bundler-client.js";
import { EntryPointMonitor, type DepositHealth } from "./entrypoint-monitor.js";
import { logEvent } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { openApiDocument } from "./openapi.js";
import {
  PaymasterRpcError,
  PaymasterService,
  type PaymasterServiceConfigInput,
} from "./paymaster-service.js";
import {
  ChainlinkOracleSource,
  CoinbaseOracleSource,
  CompositePriceProvider,
  KrakenOracleSource,
} from "./price-provider.js";
import {
  EXPENSIVE_METHODS,
  type FixedWindowRateLimiter,
  LayeredRateLimiter,
  type RateLimitResult,
  SenderChurnTracker,
} from "./rate-limit.js";
import {
  type DependencyHealth,
  type JsonRpcId,
  type JsonRpcResponse,
  isJsonRpcFailure,
  isJsonRpcRequest,
  isObject,
  makeJsonRpcError,
} from "./types.js";

const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_INTERNAL_ERROR = -32603;
const RPC_RATE_LIMITED = -32005;
const USER_OPERATION_SUBMISSION_METHODS = new Set(["eth_sendUserOperation"]);

interface RateLimitConfig {
  windowMs: number;
  maxRequestsPerWindow: number;
  /** Per-sender limit within a window. Defaults to half of maxRequestsPerWindow. */
  senderMaxRequestsPerWindow: number;
  /** Global backstop across all callers. */
  globalMaxRequestsPerWindow: number;
  /** Per-IP budget for expensive methods (pm_*, estimation). */
  expensiveMethodMaxRequestsPerWindow: number;
}

interface ApiConfig {
  bundlerRpcUrl: string;
  bundlerHealthUrl: string;
  requestTimeoutMs: number;
  rateLimit: RateLimitConfig;
  paymaster: PaymasterServiceConfigInput;
  taikoRpcUrl?: string;
  entryPointLowThresholdWei?: bigint;
  entryPointCriticalThresholdWei?: bigint;
}

export interface CreateAppOptions {
  config?: Partial<ApiConfig>;
  bundlerClient?: BundlerClient;
  paymasterService?: PaymasterService;
  metrics?: MetricsRegistry;
  rateLimiter?: FixedWindowRateLimiter | LayeredRateLimiter;
  senderChurnTracker?: SenderChurnTracker;
  /** Pass an EntryPointMonitor instance, or `null` to explicitly disable. */
  entryPointMonitor?: EntryPointMonitor | null;
}

const DEFAULT_BUNDLER_RPC_URL = "http://127.0.0.1:3001/rpc";
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const PRIVATE_KEY_PATTERN = /^0x[a-fA-F0-9]{64}$/u;
const DEFAULT_PRICE_CACHE_SECONDS = 15;
const DEFAULT_MAX_DEVIATION_BPS = 75;
const DEFAULT_ORACLE_HTTP_TIMEOUT_MS = 2_000;
const DEFAULT_CHAINLINK_ETH_MAX_AGE_SECONDS = 7_200;
const DEFAULT_CHAINLINK_USDC_MAX_AGE_SECONDS = 86_400;
const DEFAULT_ETHEREUM_MAINNET_RPC_URL = "https://ethereum-rpc.publicnode.com";

const parseIntWithFallback = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseOptionalAddress = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return ADDRESS_PATTERN.test(value) ? value : undefined;
};

const resolveConfig = (environment: NodeJS.ProcessEnv = process.env): ApiConfig => {
  const bundlerRpcUrl = environment.BUNDLER_RPC_URL ?? DEFAULT_BUNDLER_RPC_URL;
  const ethereumMainnetRpcUrl =
    environment.ETHEREUM_MAINNET_RPC_URL?.trim() || DEFAULT_ETHEREUM_MAINNET_RPC_URL;
  const tokenAddresses: NonNullable<PaymasterServiceConfigInput["tokenAddresses"]> = {};

  const mainnetToken = parseOptionalAddress(environment.USDC_MAINNET_ADDRESS);
  if (mainnetToken !== undefined) {
    tokenAddresses.taikoMainnet = mainnetToken;
  }

  const heklaToken = parseOptionalAddress(environment.USDC_HEKLA_ADDRESS);
  if (heklaToken !== undefined) {
    tokenAddresses.taikoHekla = heklaToken;
  }

  const hoodiToken = parseOptionalAddress(environment.USDC_HOODI_ADDRESS);
  if (hoodiToken !== undefined) {
    tokenAddresses.taikoHoodi = hoodiToken;
  }

  const priceProvider = new CompositePriceProvider({
    primary: new ChainlinkOracleSource({
      ethereumRpcUrl: ethereumMainnetRpcUrl,
      ethUsdFeed: parseOptionalAddress(environment.PAYMASTER_CHAINLINK_ETH_USD_FEED) as
        | `0x${string}`
        | undefined,
      usdcUsdFeed: parseOptionalAddress(environment.PAYMASTER_CHAINLINK_USDC_USD_FEED) as
        | `0x${string}`
        | undefined,
      ethUsdMaxAgeMs:
        parseIntWithFallback(
          environment.PAYMASTER_CHAINLINK_ETH_USD_MAX_AGE_SECONDS,
          DEFAULT_CHAINLINK_ETH_MAX_AGE_SECONDS,
        ) * 1000,
      usdcUsdMaxAgeMs:
        parseIntWithFallback(
          environment.PAYMASTER_CHAINLINK_USDC_USD_MAX_AGE_SECONDS,
          DEFAULT_CHAINLINK_USDC_MAX_AGE_SECONDS,
        ) * 1000,
    }),
    fallbacks: [
      new CoinbaseOracleSource({
        timeoutMs: parseIntWithFallback(
          environment.PAYMASTER_ORACLE_HTTP_TIMEOUT_MS,
          DEFAULT_ORACLE_HTTP_TIMEOUT_MS,
        ),
      }),
      new KrakenOracleSource({
        timeoutMs: parseIntWithFallback(
          environment.PAYMASTER_ORACLE_HTTP_TIMEOUT_MS,
          DEFAULT_ORACLE_HTTP_TIMEOUT_MS,
        ),
      }),
    ],
    cacheTtlMs:
      parseIntWithFallback(environment.PAYMASTER_PRICE_CACHE_SECONDS, DEFAULT_PRICE_CACHE_SECONDS) *
      1000,
    maxPrimaryDeviationBps: parseIntWithFallback(
      environment.PAYMASTER_ORACLE_MAX_DEVIATION_BPS,
      DEFAULT_MAX_DEVIATION_BPS,
    ),
  });

  const taikoRpcUrl = environment.TAIKO_RPC_URL?.trim() || undefined;

  const lowThresholdRaw = environment.ENTRYPOINT_LOW_DEPOSIT_WEI?.trim();
  const criticalThresholdRaw = environment.ENTRYPOINT_CRITICAL_DEPOSIT_WEI?.trim();

  return {
    bundlerRpcUrl,
    bundlerHealthUrl: environment.BUNDLER_HEALTH_URL ?? bundlerRpcUrl.replace(/\/rpc$/u, "/health"),
    requestTimeoutMs: parseIntWithFallback(environment.REQUEST_TIMEOUT_MS, 2_500),
    rateLimit: {
      windowMs: parseIntWithFallback(environment.RATE_LIMIT_WINDOW_MS, 60_000),
      maxRequestsPerWindow: parseIntWithFallback(environment.RATE_LIMIT_MAX_REQUESTS, 60),
      senderMaxRequestsPerWindow: parseIntWithFallback(
        environment.RATE_LIMIT_SENDER_MAX_REQUESTS,
        30,
      ),
      globalMaxRequestsPerWindow: parseIntWithFallback(
        environment.RATE_LIMIT_GLOBAL_MAX_REQUESTS,
        600,
      ),
      expensiveMethodMaxRequestsPerWindow: parseIntWithFallback(
        environment.RATE_LIMIT_EXPENSIVE_METHOD_MAX_REQUESTS,
        20,
      ),
    },
    paymaster: {
      paymasterAddress: parseOptionalAddress(environment.PAYMASTER_ADDRESS),
      quoteTtlSeconds: parseIntWithFallback(environment.PAYMASTER_QUOTE_TTL_SECONDS, 90),
      surchargeBps: parseIntWithFallback(environment.PAYMASTER_SURCHARGE_BPS, 500),
      quoteSignerPrivateKey: environment.PAYMASTER_QUOTE_SIGNER_PRIVATE_KEY as
        | `0x${string}`
        | undefined,
      accountFactoryAddress: parseOptionalAddress(environment.SERVO_ACCOUNT_FACTORY_ADDRESS),
      tokenAddresses,
      priceProvider,
    },
    taikoRpcUrl,
    entryPointLowThresholdWei: lowThresholdRaw ? BigInt(lowThresholdRaw) : undefined,
    entryPointCriticalThresholdWei: criticalThresholdRaw ? BigInt(criticalThresholdRaw) : undefined,
  };
};

export const validateConfig = (environment: NodeJS.ProcessEnv = process.env): void => {
  const errors: string[] = [];
  const configuredTokenAddresses = [
    ["USDC_MAINNET_ADDRESS", environment.USDC_MAINNET_ADDRESS],
    ["USDC_HEKLA_ADDRESS", environment.USDC_HEKLA_ADDRESS],
    ["USDC_HOODI_ADDRESS", environment.USDC_HOODI_ADDRESS],
  ];
  const configuredOracleAddresses = [
    ["PAYMASTER_CHAINLINK_ETH_USD_FEED", environment.PAYMASTER_CHAINLINK_ETH_USD_FEED],
    ["PAYMASTER_CHAINLINK_USDC_USD_FEED", environment.PAYMASTER_CHAINLINK_USDC_USD_FEED],
  ];

  if (environment.PAYMASTER_QUOTE_SIGNER_PRIVATE_KEY === undefined) {
    errors.push("PAYMASTER_QUOTE_SIGNER_PRIVATE_KEY is required");
  } else if (!PRIVATE_KEY_PATTERN.test(environment.PAYMASTER_QUOTE_SIGNER_PRIVATE_KEY)) {
    errors.push("PAYMASTER_QUOTE_SIGNER_PRIVATE_KEY must be a 32-byte hex private key");
  }

  if (environment.PAYMASTER_ADDRESS === undefined) {
    errors.push("PAYMASTER_ADDRESS is required");
  } else if (!ADDRESS_PATTERN.test(environment.PAYMASTER_ADDRESS)) {
    errors.push("PAYMASTER_ADDRESS must be a valid 20-byte hex address");
  }

  if (environment.PAYMASTER_STATIC_USDC_PER_ETH_MICROS !== undefined) {
    errors.push("PAYMASTER_STATIC_USDC_PER_ETH_MICROS is no longer supported");
  }

  if (
    environment.ETHEREUM_MAINNET_RPC_URL !== undefined &&
    environment.ETHEREUM_MAINNET_RPC_URL.trim() === ""
  ) {
    errors.push("ETHEREUM_MAINNET_RPC_URL must not be empty");
  }

  let validTokenAddressCount = 0;
  for (const [name, value] of configuredTokenAddresses) {
    if (value === undefined) {
      continue;
    }

    if (!ADDRESS_PATTERN.test(value)) {
      errors.push(`${name} must be a valid 20-byte hex address`);
      continue;
    }

    validTokenAddressCount += 1;
  }

  for (const [name, value] of configuredOracleAddresses) {
    if (value !== undefined && !ADDRESS_PATTERN.test(value)) {
      errors.push(`${name} must be a valid 20-byte hex address`);
    }
  }

  if (validTokenAddressCount === 0) {
    errors.push("At least one USDC_*_ADDRESS must be configured");
  }

  if (errors.length > 0) {
    for (const e of errors) {
      logEvent("error", "config.invalid", { detail: e });
    }
    throw new Error(`Missing required configuration:\n  - ${errors.join("\n  - ")}`);
  }
};

const getClientIdentifier = (headerValue: string | undefined): string | null => {
  if (headerValue === undefined || headerValue.trim() === "") {
    return null;
  }

  return (
    headerValue
      .split(",")
      .map((segment) => segment.trim())
      .find((segment) => segment.length > 0) ?? null
  );
};

const normalizeSender = (value: unknown): string | null =>
  typeof value === "string" && ADDRESS_PATTERN.test(value) ? value.toLowerCase() : null;

const senderFromRpcPayload = (payload: unknown): string | null => {
  if (!isJsonRpcRequest(payload) || !Array.isArray(payload.params) || payload.params.length === 0) {
    return null;
  }

  const firstParam = payload.params[0];
  if (!isObject(firstParam)) {
    return null;
  }

  return normalizeSender(firstParam.sender);
};

const applyRateLimitHeaders = (response: Response, result: RateLimitResult): void => {
  response.headers.set("X-RateLimit-Limit", String(result.limit));
  response.headers.set("X-RateLimit-Remaining", String(result.remaining));
  response.headers.set("X-RateLimit-Reset", String(result.resetAt));
};

const KNOWN_ROUTES = new Set([
  "/health",
  "/status",
  "/capabilities",
  "/metrics",
  "/openapi.json",
  "/rpc",
]);

const resolveRouteLabel = (path: string): string =>
  path === "/" ? "/" : KNOWN_ROUTES.has(path) ? path : "<unknown>";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  isObject(value) ? value : null;

const parseNonNegativeNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return null;
};

const parseUnsignedIntegerString = (value: unknown): string | null => {
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) {
    return value;
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }

  return null;
};

const parseNumericRecord = (value: unknown): Record<string, number> => {
  const source = asRecord(value);
  if (source === null) {
    return {};
  }

  const parsed: Record<string, number> = {};
  for (const [key, raw] of Object.entries(source)) {
    const numeric = parseNonNegativeNumber(raw);
    if (numeric !== null) {
      parsed[key] = numeric;
    }
  }

  return parsed;
};

interface RuntimeMonitoringSnapshot {
  entryPointDepositWei: string | null;
  submitterBalanceWei: string | null;
  mempoolDepth: {
    pending: number;
    submitting: number;
    total: number;
  };
  mempoolAgeMs: {
    pendingOldest: number;
    submittingOldest: number;
  };
  mempoolAgeDistribution: {
    pending: Record<string, number>;
    submitting: Record<string, number>;
  };
  userOpsAcceptedTotal: number;
  userOpsIncludedTotal: number;
  userOpsFailedTotal: number;
  acceptanceToInclusionSuccessRate: number;
  averageAcceptanceToInclusionMs: number;
  quoteToSubmissionConversionRate: number;
  simulationFailureReasons: Record<string, number>;
  revertReasons: Record<string, number>;
}

const extractRuntimeMonitoringSnapshot = (
  bundlerHealth: DependencyHealth,
  depositHealth: DepositHealth | undefined,
  successfulQuoteCount: number,
): RuntimeMonitoringSnapshot => {
  const details = asRecord(bundlerHealth.details);
  const submitter = asRecord(details?.submitter);
  const mempoolDepth = asRecord(details?.mempoolDepth);
  const mempoolAgeMs = asRecord(details?.mempoolAgeMs);
  const mempoolAgeDistribution = asRecord(details?.mempoolAgeDistribution);
  const operationalMetrics = asRecord(details?.operationalMetrics);

  const pendingDepth =
    parseNonNegativeNumber(mempoolDepth?.pending) ??
    parseNonNegativeNumber(details?.pendingUserOperations) ??
    0;
  const submittingDepth =
    parseNonNegativeNumber(mempoolDepth?.submitting) ??
    parseNonNegativeNumber(details?.submittingUserOperations) ??
    0;
  const totalDepth = parseNonNegativeNumber(mempoolDepth?.total) ?? pendingDepth + submittingDepth;

  const acceptedTotal = parseNonNegativeNumber(operationalMetrics?.userOpsAcceptedTotal) ?? 0;
  const includedTotal = parseNonNegativeNumber(operationalMetrics?.userOpsIncludedTotal) ?? 0;
  const failedTotal = parseNonNegativeNumber(operationalMetrics?.userOpsFailedTotal) ?? 0;

  const derivedSuccessRate =
    acceptedTotal === 0 ? 0 : Number((includedTotal / acceptedTotal).toFixed(6));
  const successRate =
    parseNonNegativeNumber(operationalMetrics?.acceptanceToInclusionSuccessRate) ??
    derivedSuccessRate;
  const averageAcceptanceToInclusionMs =
    parseNonNegativeNumber(operationalMetrics?.averageAcceptanceToInclusionMs) ?? 0;

  return {
    entryPointDepositWei: parseUnsignedIntegerString(depositHealth?.balanceWei),
    submitterBalanceWei: parseUnsignedIntegerString(submitter?.lastKnownBalanceWei),
    mempoolDepth: {
      pending: pendingDepth,
      submitting: submittingDepth,
      total: totalDepth,
    },
    mempoolAgeMs: {
      pendingOldest: parseNonNegativeNumber(mempoolAgeMs?.pendingOldest) ?? 0,
      submittingOldest: parseNonNegativeNumber(mempoolAgeMs?.submittingOldest) ?? 0,
    },
    mempoolAgeDistribution: {
      pending: parseNumericRecord(mempoolAgeDistribution?.pending),
      submitting: parseNumericRecord(mempoolAgeDistribution?.submitting),
    },
    userOpsAcceptedTotal: acceptedTotal,
    userOpsIncludedTotal: includedTotal,
    userOpsFailedTotal: failedTotal,
    acceptanceToInclusionSuccessRate: successRate,
    averageAcceptanceToInclusionMs,
    quoteToSubmissionConversionRate:
      successfulQuoteCount === 0 ? 0 : Number((acceptedTotal / successfulQuoteCount).toFixed(6)),
    simulationFailureReasons: parseNumericRecord(operationalMetrics?.simulationFailureReasons),
    revertReasons: parseNumericRecord(operationalMetrics?.revertReasons),
  };
};

const formatPrometheusLabels = (labels: Record<string, string>): string => {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return "";
  }

  const serialized = entries
    .map(([key, value]) => `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join(",");
  return `{${serialized}}`;
};

interface PrometheusSample {
  labels?: Record<string, string>;
  value: number | string;
}

const appendMetricBlock = (
  lines: string[],
  name: string,
  help: string,
  type: "gauge" | "counter",
  samples: PrometheusSample[],
): void => {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);

  for (const sample of samples) {
    const labels = sample.labels ? formatPrometheusLabels(sample.labels) : "";
    lines.push(`${name}${labels} ${sample.value}`);
  }
};

const renderRuntimeMonitoringPrometheus = (snapshot: RuntimeMonitoringSnapshot): string => {
  const lines: string[] = [];

  if (snapshot.entryPointDepositWei !== null) {
    appendMetricBlock(
      lines,
      "api_entrypoint_deposit_wei",
      "Current EntryPoint paymaster deposit balance in wei",
      "gauge",
      [{ value: snapshot.entryPointDepositWei }],
    );
  }

  if (snapshot.submitterBalanceWei !== null) {
    appendMetricBlock(
      lines,
      "api_bundler_submitter_balance_wei",
      "Current bundler submitter ETH balance in wei",
      "gauge",
      [{ value: snapshot.submitterBalanceWei }],
    );
  }

  appendMetricBlock(
    lines,
    "api_bundler_mempool_depth",
    "Current bundler mempool depth by state",
    "gauge",
    [
      { labels: { state: "pending" }, value: snapshot.mempoolDepth.pending },
      { labels: { state: "submitting" }, value: snapshot.mempoolDepth.submitting },
      { labels: { state: "total" }, value: snapshot.mempoolDepth.total },
    ],
  );

  appendMetricBlock(
    lines,
    "api_bundler_mempool_oldest_age_ms",
    "Oldest user operation age in the bundler mempool by state",
    "gauge",
    [
      { labels: { state: "pending" }, value: snapshot.mempoolAgeMs.pendingOldest },
      { labels: { state: "submitting" }, value: snapshot.mempoolAgeMs.submittingOldest },
    ],
  );

  const ageDistributionSamples: PrometheusSample[] = [];
  for (const [bucket, value] of Object.entries(snapshot.mempoolAgeDistribution.pending).sort()) {
    ageDistributionSamples.push({
      labels: { state: "pending", bucket },
      value,
    });
  }
  for (const [bucket, value] of Object.entries(snapshot.mempoolAgeDistribution.submitting).sort()) {
    ageDistributionSamples.push({
      labels: { state: "submitting", bucket },
      value,
    });
  }
  if (ageDistributionSamples.length > 0) {
    appendMetricBlock(
      lines,
      "api_bundler_mempool_age_bucket",
      "Bundler mempool age distribution counts by bucket and state",
      "gauge",
      ageDistributionSamples,
    );
  }

  appendMetricBlock(
    lines,
    "api_userop_lifecycle_total",
    "Bundler user operation lifecycle counters since process start",
    "gauge",
    [
      { labels: { stage: "accepted" }, value: snapshot.userOpsAcceptedTotal },
      { labels: { stage: "included" }, value: snapshot.userOpsIncludedTotal },
      { labels: { stage: "failed" }, value: snapshot.userOpsFailedTotal },
    ],
  );

  appendMetricBlock(
    lines,
    "api_userop_acceptance_to_inclusion_success_ratio",
    "Ratio of accepted user operations that reached successful inclusion",
    "gauge",
    [{ value: snapshot.acceptanceToInclusionSuccessRate }],
  );

  appendMetricBlock(
    lines,
    "api_userop_acceptance_to_inclusion_avg_ms",
    "Average milliseconds from acceptance to successful inclusion",
    "gauge",
    [{ value: snapshot.averageAcceptanceToInclusionMs }],
  );

  appendMetricBlock(
    lines,
    "api_quote_to_submission_conversion_ratio",
    "Ratio of successful paymaster quotes to accepted user operations",
    "gauge",
    [{ value: snapshot.quoteToSubmissionConversionRate }],
  );

  const simulationFailureSamples: PrometheusSample[] = Object.entries(
    snapshot.simulationFailureReasons,
  )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, value]) => ({
      labels: { reason },
      value,
    }));
  if (simulationFailureSamples.length > 0) {
    appendMetricBlock(
      lines,
      "api_userop_simulation_failures_total",
      "Distribution of simulation and admission-time failure reasons",
      "gauge",
      simulationFailureSamples,
    );
  }

  const revertReasonSamples: PrometheusSample[] = Object.entries(snapshot.revertReasons)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, value]) => ({
      labels: { reason },
      value,
    }));
  if (revertReasonSamples.length > 0) {
    appendMetricBlock(
      lines,
      "api_userop_revert_reasons_total",
      "Distribution of on-chain handleOps revert reasons",
      "gauge",
      revertReasonSamples,
    );
  }

  if (lines.length === 0) {
    return "";
  }

  return `${lines.join("\n")}\n`;
};

const mergeConfig = (base: ApiConfig, override: Partial<ApiConfig> | undefined): ApiConfig => {
  if (override === undefined) {
    return base;
  }

  const mergedTokenAddresses = {
    ...base.paymaster.tokenAddresses,
    ...(override.paymaster?.tokenAddresses ?? {}),
  };

  if (mergedTokenAddresses.taikoMainnet === undefined) {
    delete mergedTokenAddresses.taikoMainnet;
  }

  if (mergedTokenAddresses.taikoHekla === undefined) {
    delete mergedTokenAddresses.taikoHekla;
  }

  if (mergedTokenAddresses.taikoHoodi === undefined) {
    delete mergedTokenAddresses.taikoHoodi;
  }

  return {
    ...base,
    ...override,
    rateLimit: {
      ...base.rateLimit,
      ...(override.rateLimit ?? {}),
    },
    paymaster: {
      ...base.paymaster,
      ...(override.paymaster ?? {}),
      tokenAddresses: mergedTokenAddresses,
    },
  };
};

export const createApp = (options: CreateAppOptions = {}): Hono => {
  const mergedConfig = mergeConfig(resolveConfig(), options.config);

  const metrics = options.metrics ?? new MetricsRegistry();
  const bundlerClient =
    options.bundlerClient ??
    new HttpBundlerClient({
      rpcUrl: mergedConfig.bundlerRpcUrl,
      healthUrl: mergedConfig.bundlerHealthUrl,
      timeoutMs: mergedConfig.requestTimeoutMs,
    });

  const paymasterService =
    options.paymasterService ?? new PaymasterService(bundlerClient, mergedConfig.paymaster);

  const rateLimiter =
    options.rateLimiter ??
    new LayeredRateLimiter({
      ip: {
        maxRequestsPerWindow: mergedConfig.rateLimit.maxRequestsPerWindow,
        windowMs: mergedConfig.rateLimit.windowMs,
      },
      sender: {
        maxRequestsPerWindow: mergedConfig.rateLimit.senderMaxRequestsPerWindow,
        windowMs: mergedConfig.rateLimit.windowMs,
      },
      global: {
        maxRequestsPerWindow: mergedConfig.rateLimit.globalMaxRequestsPerWindow,
        windowMs: mergedConfig.rateLimit.windowMs,
      },
      expensiveMethod: {
        maxRequestsPerWindow: mergedConfig.rateLimit.expensiveMethodMaxRequestsPerWindow,
        windowMs: mergedConfig.rateLimit.windowMs,
      },
    });

  const senderChurnTracker =
    options.senderChurnTracker ?? new SenderChurnTracker(mergedConfig.rateLimit.windowMs);

  const entryPointMonitor =
    options.entryPointMonitor === null
      ? undefined
      : (options.entryPointMonitor ??
        (mergedConfig.paymaster.paymasterAddress
          ? new EntryPointMonitor({
              taikoRpcUrl: mergedConfig.taikoRpcUrl,
              paymasterAddress: mergedConfig.paymaster.paymasterAddress,
              lowThresholdWei: mergedConfig.entryPointLowThresholdWei,
              criticalThresholdWei: mergedConfig.entryPointCriticalThresholdWei,
            })
          : undefined));

  const app = new Hono();

  app.use("*", async (c, next) => {
    const startedAt = Date.now();
    const requestId = randomUUID();

    try {
      await next();
    } catch (error) {
      logEvent("error", "request.unhandled_error", {
        requestId,
        path: c.req.path,
        method: c.req.method,
        error: error instanceof Error ? error.message : "unknown_error",
      });

      c.res = c.json(
        {
          error: {
            code: "internal_error",
            message: "Internal server error",
          },
        },
        500,
      );
    } finally {
      const durationMs = Date.now() - startedAt;
      const route = resolveRouteLabel(c.req.path);

      metrics.recordHttp(c.req.method, route, c.res.status, durationMs);

      logEvent("info", "request.completed", {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs,
      });
    }
  });

  app.get("/health", async (c) => {
    const [bundlerHealth, depositHealth] = await Promise.all([
      bundlerClient.health(),
      entryPointMonitor?.checkDeposit() ?? Promise.resolve(undefined),
    ]);

    const depositDegraded = depositHealth?.status === "critical";
    const status = bundlerHealth.status !== "ok" || depositDegraded ? "degraded" : "ok";

    return c.json({
      ...buildHealth("api"),
      status,
      dependencies: {
        bundler: bundlerHealth,
        ...(depositHealth !== undefined ? { entryPointDeposit: depositHealth } : {}),
      },
    });
  });

  app.get("/status", async (c) => {
    const [bundlerHealth, depositHealth] = await Promise.all([
      bundlerClient.health(),
      entryPointMonitor?.checkDeposit() ?? Promise.resolve(undefined),
    ]);

    const depositDegraded = depositHealth?.status === "critical";
    const status = bundlerHealth.status !== "ok" || depositDegraded ? "degraded" : "ready";

    return c.json({
      service: "api",
      status,
      dependencies: {
        bundler: bundlerHealth,
        ...(depositHealth !== undefined ? { entryPointDeposit: depositHealth } : {}),
      },
      paymaster: paymasterService.getConfigSummary(),
      metrics: metrics.snapshot(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/capabilities", (c) => c.json(paymasterService.getCapabilities()));

  app.get("/metrics", async (c) => {
    const [bundlerHealth, depositHealth] = await Promise.all([
      bundlerClient.health(),
      entryPointMonitor?.checkDeposit() ?? Promise.resolve(undefined),
    ]);
    const successfulQuotes = metrics.getCounterSum("api_paymaster_quotes_total", {
      result: "ok",
    });
    const runtimeSnapshot = extractRuntimeMonitoringSnapshot(
      bundlerHealth,
      depositHealth,
      successfulQuotes,
    );

    c.header("Content-Type", "text/plain; version=0.0.4");
    return c.body(
      `${metrics.renderPrometheus()}${renderRuntimeMonitoringPrometheus(runtimeSnapshot)}`,
    );
  });

  app.get("/openapi.json", (c) => c.json(openApiDocument));

  app.post("/rpc", async (c) => {
    let payload: unknown;

    try {
      payload = await c.req.json();
    } catch {
      const response = makeJsonRpcError(null, RPC_PARSE_ERROR, "Parse error");
      metrics.recordRpc("<parse>", "error");
      return c.json(response, 200);
    }

    if (!isJsonRpcRequest(payload)) {
      const invalidId: JsonRpcId =
        isObject(payload) &&
        (typeof payload.id === "string" || typeof payload.id === "number" || payload.id === null)
          ? payload.id
          : null;
      const response = makeJsonRpcError(invalidId, RPC_INVALID_REQUEST, "Invalid Request");
      metrics.recordRpc("<invalid>", "error");
      return c.json(response, 200);
    }

    const sender = senderFromRpcPayload(payload);
    const clientIp =
      getClientIdentifier(c.req.header("x-forwarded-for")) ??
      getClientIdentifier(c.req.header("cf-connecting-ip")) ??
      "anonymous";

    // Track sender churn telemetry
    if (sender !== null) {
      const churnCount = senderChurnTracker.record(clientIp, sender);
      metrics.recordSenderChurn(clientIp, churnCount);
    }

    // Track expensive method pressure
    if (EXPENSIVE_METHODS.has(payload.method)) {
      metrics.recordExpensiveMethodRequest(payload.method);
    }

    // Layered rate limit: IP + sender + global + method budgets
    const rateLimitResult =
      rateLimiter instanceof LayeredRateLimiter
        ? rateLimiter.consume({ ip: clientIp, sender, method: payload.method })
        : rateLimiter.consume(sender === null ? `ip:${clientIp}` : `sender:${sender}`);

    if (!rateLimitResult.allowed) {
      const layer: string =
        "rejectedLayer" in rateLimitResult
          ? String(rateLimitResult.rejectedLayer ?? "unknown")
          : "single";
      const response = makeJsonRpcError(payload.id, RPC_RATE_LIMITED, "Rate limit exceeded", {
        limit: rateLimitResult.limit,
        resetAt: rateLimitResult.resetAt,
      });
      metrics.recordRateLimit("/rpc", layer);
      metrics.recordRpc(payload.method, "error");

      const result = c.json(response, 200);
      applyRateLimitHeaders(result, rateLimitResult);
      return result;
    }

    let rpcResponse: JsonRpcResponse;

    try {
      if (USER_OPERATION_SUBMISSION_METHODS.has(payload.method)) {
        const entryPointArg =
          Array.isArray(payload.params) && payload.params.length >= 2 ? payload.params[1] : undefined;
        paymasterService.validateUserOperationEntryPoint(entryPointArg, payload.method);
      }

      if (payload.method.startsWith("pm_")) {
        const result = await paymasterService.handleRpc(payload.method, payload.params);
        rpcResponse = {
          jsonrpc: "2.0",
          id: payload.id,
          result,
        } as const;
      } else {
        rpcResponse = await bundlerClient.rpc(payload);
      }
    } catch (error) {
      logEvent("error", "rpc.handler_failure", {
        method: payload.method,
        error: error instanceof Error ? error.message : "rpc_handler_failure",
      });
      const response =
        error instanceof PaymasterRpcError
          ? makeJsonRpcError(payload.id, error.code, error.message, error.data)
          : makeJsonRpcError(payload.id, RPC_INTERNAL_ERROR, "Internal error", {
              reason: "rpc_handler_failure",
            });

      metrics.recordRpc(payload.method, "error");
      const result = c.json(response, 200);
      applyRateLimitHeaders(result, rateLimitResult);
      return result;
    }

    metrics.recordRpc(payload.method, isJsonRpcFailure(rpcResponse) ? "error" : "ok");

    const result = c.json(rpcResponse, 200);
    applyRateLimitHeaders(result, rateLimitResult);
    return result;
  });

  return app;
};
