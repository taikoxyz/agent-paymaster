import { randomBytes, randomUUID } from "node:crypto";

import { buildHealth } from "@agent-paymaster/shared";
import { Hono } from "hono";

import { type BundlerClient, HttpBundlerClient } from "./bundler-client.js";
import { logEvent } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { openApiDocument } from "./openapi.js";
import { PaymasterService, type PaymasterServiceConfigInput } from "./paymaster-service.js";
import { FixedWindowRateLimiter, type RateLimitResult } from "./rate-limit.js";
import {
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

interface RateLimitConfig {
  windowMs: number;
  maxRequestsPerWindow: number;
}

interface ApiConfig {
  bundlerRpcUrl: string;
  bundlerHealthUrl: string;
  requestTimeoutMs: number;
  rateLimit: RateLimitConfig;
  paymaster: PaymasterServiceConfigInput;
}

export interface CreateAppOptions {
  config?: Partial<ApiConfig>;
  bundlerClient?: BundlerClient;
  paymasterService?: PaymasterService;
  metrics?: MetricsRegistry;
  rateLimiter?: FixedWindowRateLimiter;
}

const DEFAULT_BUNDLER_RPC_URL = "http://127.0.0.1:3001/rpc";
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

const parseIntWithFallback = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseBigIntWithFallback = (value: string | undefined, fallback: bigint): bigint => {
  if (value === undefined) {
    return fallback;
  }

  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const parseOptionalAddress = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  return ADDRESS_PATTERN.test(value) ? value : undefined;
};

const resolveConfig = (environment: NodeJS.ProcessEnv = process.env): ApiConfig => {
  const bundlerRpcUrl = environment.BUNDLER_RPC_URL ?? DEFAULT_BUNDLER_RPC_URL;
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

  return {
    bundlerRpcUrl,
    bundlerHealthUrl: environment.BUNDLER_HEALTH_URL ?? bundlerRpcUrl.replace(/\/rpc$/u, "/health"),
    requestTimeoutMs: parseIntWithFallback(environment.REQUEST_TIMEOUT_MS, 2_500),
    rateLimit: {
      windowMs: parseIntWithFallback(environment.RATE_LIMIT_WINDOW_MS, 60_000),
      maxRequestsPerWindow: parseIntWithFallback(environment.RATE_LIMIT_MAX_REQUESTS, 60),
    },
    paymaster: {
      paymasterAddress: parseOptionalAddress(environment.PAYMASTER_ADDRESS),
      quoteTtlSeconds: parseIntWithFallback(environment.PAYMASTER_QUOTE_TTL_SECONDS, 90),
      usdcPerEthMicros: parseBigIntWithFallback(environment.USDC_PER_ETH_MICROS, 0n),
      surchargeBps: parseIntWithFallback(environment.PAYMASTER_SURCHARGE_BPS, 500),
      quoteSignerPrivateKey:
        (environment.PAYMASTER_QUOTE_SIGNER_PRIVATE_KEY as `0x${string}` | undefined) ??
        (`0x${randomBytes(32).toString("hex")}` as `0x${string}`),
      tokenAddresses,
    },
  };
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

const senderFromQuoteBody = (payload: unknown): string | null => {
  if (!isObject(payload)) {
    return null;
  }

  const direct = normalizeSender(payload.sender);
  if (direct !== null) {
    return direct;
  }

  if (!isObject(payload.userOperation)) {
    return null;
  }

  return normalizeSender(payload.userOperation.sender);
};

const applyRateLimitHeaders = (response: Response, result: RateLimitResult): void => {
  response.headers.set("X-RateLimit-Limit", String(result.limit));
  response.headers.set("X-RateLimit-Remaining", String(result.remaining));
  response.headers.set("X-RateLimit-Reset", String(result.resetAt));
};

const resolveRouteLabel = (path: string): string => {
  if (path === "/") {
    return "/";
  }

  const knownRoutes = new Set([
    "/health",
    "/status",
    "/metrics",
    "/openapi.json",
    "/rpc",
    "/v1/paymaster/quote",
  ]);

  return knownRoutes.has(path) ? path : "<unknown>";
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
    new FixedWindowRateLimiter({
      maxRequestsPerWindow: mergedConfig.rateLimit.maxRequestsPerWindow,
      windowMs: mergedConfig.rateLimit.windowMs,
    });

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
    const bundlerHealth = await bundlerClient.health();

    const status = bundlerHealth.status === "ok" ? "ok" : "degraded";

    return c.json({
      ...buildHealth("api"),
      status,
      dependencies: {
        bundler: bundlerHealth,
      },
    });
  });

  app.get("/status", async (c) => {
    const bundlerHealth = await bundlerClient.health();

    return c.json({
      service: "api",
      status: bundlerHealth.status === "ok" ? "ready" : "degraded",
      dependencies: {
        bundler: bundlerHealth,
      },
      paymaster: paymasterService.getConfigSummary(),
      metrics: metrics.snapshot(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/metrics", (c) => {
    c.header("Content-Type", "text/plain; version=0.0.4");
    return c.body(metrics.renderPrometheus());
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
    const fallbackClientId =
      getClientIdentifier(c.req.header("x-forwarded-for")) ??
      getClientIdentifier(c.req.header("cf-connecting-ip")) ??
      "anonymous";

    const limiterKey = sender === null ? `ip:${fallbackClientId}` : `sender:${sender}`;
    const rateLimitResult = rateLimiter.consume(limiterKey);

    if (!rateLimitResult.allowed) {
      const response = makeJsonRpcError(payload.id, RPC_RATE_LIMITED, "Rate limit exceeded", {
        limit: rateLimitResult.limit,
        resetAt: rateLimitResult.resetAt,
      });
      metrics.recordRateLimit("/rpc");
      metrics.recordRpc(payload.method, "error");

      const result = c.json(response, 200);
      applyRateLimitHeaders(result, rateLimitResult);
      return result;
    }

    let rpcResponse: JsonRpcResponse;

    try {
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
      const response = makeJsonRpcError(payload.id, RPC_INTERNAL_ERROR, "Internal error", {
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

  app.post("/v1/paymaster/quote", async (c) => {
    const body = await c.req.json().catch(() => null);

    if (body === null) {
      return c.json(
        {
          error: {
            code: "invalid_json",
            message: "Body must be valid JSON",
          },
        },
        400,
      );
    }

    const sender = senderFromQuoteBody(body);
    const fallbackClientId =
      getClientIdentifier(c.req.header("x-forwarded-for")) ??
      getClientIdentifier(c.req.header("cf-connecting-ip")) ??
      "anonymous";

    const limiterKey = sender === null ? `ip:${fallbackClientId}` : `sender:${sender}`;
    const rateLimitResult = rateLimiter.consume(limiterKey);

    if (!rateLimitResult.allowed) {
      metrics.recordRateLimit("/v1/paymaster/quote");

      const result = c.json(
        {
          error: {
            code: "rate_limit_exceeded",
            message: "Rate limit exceeded",
            limit: rateLimitResult.limit,
            resetAt: rateLimitResult.resetAt,
          },
        },
        429,
      );
      applyRateLimitHeaders(result, rateLimitResult);
      return result;
    }

    try {
      const quote = await paymasterService.quote(body);
      metrics.recordQuote(quote.chain, "ok");

      const result = c.json({
        ...quote,
        supportedTokens: ["USDC"],
      });

      applyRateLimitHeaders(result, rateLimitResult);
      return result;
    } catch (error) {
      logEvent("error", "quote.generation_failed", {
        error: error instanceof Error ? error.message : "quote_generation_failed",
      });
      metrics.recordQuote("unknown", "error");

      const result = c.json(
        {
          error: {
            code: "quote_generation_failed",
            message: "Unable to generate quote",
          },
        },
        400,
      );
      applyRateLimitHeaders(result, rateLimitResult);
      return result;
    }
  });

  return app;
};
