import { logEvent, type ChainName } from "@agent-paymaster/shared";
import { createPublicClient, http, parseAbi, type Address } from "viem";

export interface PriceProvider {
  getUsdcPerEthMicros(chain: ChainName): bigint | Promise<bigint>;
  describe(): string;
}

interface PriceObservation {
  source: string;
  usdcPerEthMicros: bigint;
  observedAtMs: number;
}

export interface OracleSource {
  readonly name: string;
  getObservation(chain: ChainName): Promise<PriceObservation>;
}

interface CachedPrice {
  value: bigint;
  expiresAtMs: number;
}

interface CompositePriceProviderConfig {
  primary: OracleSource;
  fallbacks: readonly OracleSource[];
  maxPrimaryDeviationBps?: number;
  cacheTtlMs?: number;
  nowMs?: () => number;
}

export class CompositePriceProvider implements PriceProvider {
  private readonly primary: OracleSource;
  private readonly fallbacks: readonly OracleSource[];
  private readonly maxPrimaryDeviationBps: number;
  private readonly cacheTtlMs: number;
  private readonly nowMs: () => number;
  private readonly cache = new Map<ChainName, CachedPrice>();
  private readonly inflight = new Map<ChainName, Promise<bigint>>();

  constructor(config: CompositePriceProviderConfig) {
    if (config.maxPrimaryDeviationBps !== undefined && config.maxPrimaryDeviationBps < 0) {
      throw new Error("maxPrimaryDeviationBps must be non-negative");
    }

    if (config.cacheTtlMs !== undefined && config.cacheTtlMs < 0) {
      throw new Error("cacheTtlMs must be non-negative");
    }

    this.primary = config.primary;
    this.fallbacks = config.fallbacks;
    this.maxPrimaryDeviationBps = config.maxPrimaryDeviationBps ?? 75;
    this.cacheTtlMs = config.cacheTtlMs ?? 15_000;
    this.nowMs = config.nowMs ?? (() => Date.now());
  }

  async getUsdcPerEthMicros(chain: ChainName): Promise<bigint> {
    const now = this.nowMs();
    const cached = this.cache.get(chain);
    if (cached !== undefined && cached.expiresAtMs > now) {
      return cached.value;
    }

    const existing = this.inflight.get(chain);
    if (existing !== undefined) {
      return existing;
    }

    const pending = this.resolveUsdcPerEthMicros(chain)
      .then((value) => {
        this.cache.set(chain, {
          value,
          expiresAtMs: this.nowMs() + this.cacheTtlMs,
        });
        return value;
      })
      .finally(() => {
        this.inflight.delete(chain);
      });

    this.inflight.set(chain, pending);
    return pending;
  }

  describe(): string {
    return `composite(${this.primary.name}->${this.fallbacks
      .map((source) => source.name)
      .join(
        ",",
      )};cache=${Math.floor(this.cacheTtlMs / 1000)}s;deviation=${this.maxPrimaryDeviationBps}bps)`;
  }

  private async resolveUsdcPerEthMicros(chain: ChainName): Promise<bigint> {
    const sources = [this.primary, ...this.fallbacks];
    const results = await Promise.allSettled(
      sources.map(async (source) => ({
        source,
        observation: await source.getObservation(chain),
      })),
    );

    const successful = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const primaryResult = successful.find((result) => result.source.name === this.primary.name);
    const fallbackResults = successful.filter((result) => result.source.name !== this.primary.name);

    if (primaryResult !== undefined) {
      if (successful.length < 2) {
        logEvent("warn", "oracle.quorum_degraded", {
          availableSources: successful.length,
          source: primaryResult.source.name,
          detail: "Using primary oracle without cross-validation — fallback sources unavailable",
        });
        return primaryResult.observation.usdcPerEthMicros;
      }

      const marketMedian = median(successful.map((result) => result.observation.usdcPerEthMicros));
      const deviationBps = deviationInBps(primaryResult.observation.usdcPerEthMicros, marketMedian);
      if (deviationBps > this.maxPrimaryDeviationBps) {
        throw new Error(
          `${primaryResult.source.name} deviated ${deviationBps}bps from oracle median`,
        );
      }

      return primaryResult.observation.usdcPerEthMicros;
    }

    if (fallbackResults.length < 2) {
      throw new Error(
        `Oracle quorum unavailable: expected at least 2 fallback sources, got ${fallbackResults.length}`,
      );
    }

    return median(fallbackResults.map((result) => result.observation.usdcPerEthMicros));
  }
}

const CHAINLINK_AGGREGATOR_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

const DEFAULT_CHAINLINK_ETH_USD_FEED =
  "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419" as const satisfies Address;
const DEFAULT_CHAINLINK_USDC_USD_FEED =
  "0x8fffffd4afb6115b954bd326cbe7b4ba576818f6" as const satisfies Address;

interface ChainlinkFeedSnapshot {
  answer: bigint;
  decimals: number;
  updatedAtMs: number;
}

type ChainlinkFeedReader = (feedAddress: Address) => Promise<ChainlinkFeedSnapshot>;

interface ChainlinkOracleSourceConfig {
  ethereumRpcUrl?: string;
  ethUsdFeed?: Address;
  usdcUsdFeed?: Address;
  ethUsdMaxAgeMs?: number;
  usdcUsdMaxAgeMs?: number;
  readFeed?: ChainlinkFeedReader;
  nowMs?: () => number;
}

export class ChainlinkOracleSource implements OracleSource {
  readonly name = "chainlink";

  private readonly ethUsdFeed: Address;
  private readonly usdcUsdFeed: Address;
  private readonly ethUsdMaxAgeMs: number;
  private readonly usdcUsdMaxAgeMs: number;
  private readonly readFeed: ChainlinkFeedReader;
  private readonly nowMs: () => number;

  constructor(config: ChainlinkOracleSourceConfig) {
    if (config.readFeed === undefined && config.ethereumRpcUrl === undefined) {
      throw new Error("Chainlink oracle source requires ethereumRpcUrl or readFeed");
    }

    this.ethUsdFeed = config.ethUsdFeed ?? DEFAULT_CHAINLINK_ETH_USD_FEED;
    this.usdcUsdFeed = config.usdcUsdFeed ?? DEFAULT_CHAINLINK_USDC_USD_FEED;
    this.ethUsdMaxAgeMs = config.ethUsdMaxAgeMs ?? 2 * 60 * 60 * 1000;
    this.usdcUsdMaxAgeMs = config.usdcUsdMaxAgeMs ?? 24 * 60 * 60 * 1000;
    this.readFeed = config.readFeed ?? createChainlinkFeedReader(config.ethereumRpcUrl as string);
    this.nowMs = config.nowMs ?? (() => Date.now());
  }

  async getObservation(): Promise<PriceObservation> {
    const now = this.nowMs();
    const [ethUsd, usdcUsd] = await Promise.all([
      this.readFeed(this.ethUsdFeed),
      this.readFeed(this.usdcUsdFeed),
    ]);

    assertFresh(now, ethUsd.updatedAtMs, this.ethUsdMaxAgeMs, "chainlink ETH/USD");
    assertFresh(now, usdcUsd.updatedAtMs, this.usdcUsdMaxAgeMs, "chainlink USDC/USD");

    return {
      source: this.name,
      usdcPerEthMicros: divideScaledIntegers(
        ethUsd.answer,
        ethUsd.decimals,
        usdcUsd.answer,
        usdcUsd.decimals,
      ),
      observedAtMs: Math.min(ethUsd.updatedAtMs, usdcUsd.updatedAtMs),
    };
  }
}

const createChainlinkFeedReader = (ethereumRpcUrl: string): ChainlinkFeedReader => {
  const publicClient = createPublicClient({
    transport: http(ethereumRpcUrl),
  });
  const decimalsCache = new Map<Address, Promise<number>>();

  return async (feedAddress) => {
    const decimalsPromise =
      decimalsCache.get(feedAddress) ??
      publicClient
        .readContract({
          address: feedAddress,
          abi: CHAINLINK_AGGREGATOR_ABI,
          functionName: "decimals",
        })
        .then((value) => Number(value));

    decimalsCache.set(feedAddress, decimalsPromise);

    const [decimals, latestRoundData] = await Promise.all([
      decimalsPromise,
      publicClient.readContract({
        address: feedAddress,
        abi: CHAINLINK_AGGREGATOR_ABI,
        functionName: "latestRoundData",
      }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>,
    ]);

    const [, answer, , updatedAt] = latestRoundData;
    if (answer <= 0n) {
      throw new Error(`Chainlink feed ${feedAddress} returned a non-positive answer`);
    }

    return {
      answer,
      decimals,
      updatedAtMs: Number(updatedAt) * 1000,
    };
  };
};

interface HttpOracleSourceConfig {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  nowMs?: () => number;
}

interface CoinbaseTickerResponse {
  price?: string;
  time?: string;
}

export class CoinbaseOracleSource implements OracleSource {
  readonly name = "coinbase";

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly nowMs: () => number;

  constructor(config: HttpOracleSourceConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 2_000;
    this.nowMs = config.nowMs ?? (() => Date.now());
  }

  async getObservation(): Promise<PriceObservation> {
    const [ethUsd, usdcUsd] = await Promise.all([
      fetchJson<CoinbaseTickerResponse>(
        this.fetchImpl,
        "https://api.exchange.coinbase.com/products/ETH-USD/ticker",
        this.timeoutMs,
      ),
      fetchJson<CoinbaseTickerResponse>(
        this.fetchImpl,
        "https://api.exchange.coinbase.com/products/USDC-USD/ticker",
        this.timeoutMs,
      ),
    ]);

    const observedAtMs = Math.min(
      parseObservedAt(ethUsd.time, this.nowMs()),
      parseObservedAt(usdcUsd.time, this.nowMs()),
    );

    return {
      source: this.name,
      usdcPerEthMicros: ratioFromDecimalStrings(
        requiredDecimalString(ethUsd.price, "coinbase ETH-USD"),
        requiredDecimalString(usdcUsd.price, "coinbase USDC-USD"),
      ),
      observedAtMs,
    };
  }
}

interface KrakenTicker {
  c?: string[];
}

interface KrakenTickerResponse {
  error?: string[];
  result?: Record<string, KrakenTicker>;
}

export class KrakenOracleSource implements OracleSource {
  readonly name = "kraken";

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly nowMs: () => number;

  constructor(config: HttpOracleSourceConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 2_000;
    this.nowMs = config.nowMs ?? (() => Date.now());
  }

  async getObservation(): Promise<PriceObservation> {
    const [ethUsd, usdcUsd] = await Promise.all([
      this.fetchTicker("ETHUSD"),
      this.fetchTicker("USDCUSD"),
    ]);

    return {
      source: this.name,
      usdcPerEthMicros: ratioFromDecimalStrings(ethUsd, usdcUsd),
      observedAtMs: this.nowMs(),
    };
  }

  private async fetchTicker(pair: string): Promise<string> {
    const response = await fetchJson<KrakenTickerResponse>(
      this.fetchImpl,
      `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pair)}`,
      this.timeoutMs,
    );

    if ((response.error?.length ?? 0) > 0) {
      throw new Error(`Kraken ${pair} request failed: ${response.error?.join(", ")}`);
    }

    const tickerEntry = Object.entries(response.result ?? {}).find(([key]) => key !== "last");
    const lastTradePrice = tickerEntry?.[1]?.c?.[0];
    return requiredDecimalString(lastTradePrice, `kraken ${pair}`);
  }
}

const fetchJson = async <T>(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
};

const parseObservedAt = (value: string | undefined, fallbackMs: number): number => {
  if (value === undefined) {
    return fallbackMs;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
};

const requiredDecimalString = (value: string | undefined, fieldName: string): string => {
  if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`${fieldName} did not return a decimal price`);
  }

  return value;
};

const parseDecimalToScaledInteger = (value: string, decimals: number): bigint => {
  const [whole, fraction = ""] = value.split(".");
  const normalizedFraction = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(normalizedFraction);
};

const ratioFromDecimalStrings = (numerator: string, denominator: string): bigint => {
  const scaledNumerator = parseDecimalToScaledInteger(numerator, 18);
  const scaledDenominator = parseDecimalToScaledInteger(denominator, 18);
  if (scaledDenominator <= 0n) {
    throw new Error("oracle denominator price must be positive");
  }

  return (scaledNumerator * 1_000_000n) / scaledDenominator;
};

const divideScaledIntegers = (
  numerator: bigint,
  numeratorDecimals: number,
  denominator: bigint,
  denominatorDecimals: number,
): bigint => {
  if (numerator <= 0n || denominator <= 0n) {
    throw new Error("oracle prices must be positive");
  }

  return (
    (numerator * 1_000_000n * 10n ** BigInt(denominatorDecimals)) /
    (denominator * 10n ** BigInt(numeratorDecimals))
  );
};

const assertFresh = (
  nowMs: number,
  observedAtMs: number,
  maxAgeMs: number,
  sourceLabel: string,
): void => {
  if (observedAtMs <= 0 || nowMs - observedAtMs > maxAgeMs) {
    throw new Error(`${sourceLabel} is stale`);
  }
};

export const median = (values: readonly bigint[]): bigint => {
  if (values.length === 0) {
    throw new Error("Cannot compute a median from an empty set");
  }

  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[midpoint] as bigint;
  }

  return ((sorted[midpoint - 1] as bigint) + (sorted[midpoint] as bigint)) / 2n;
};

const deviationInBps = (value: bigint, reference: bigint): bigint => {
  if (reference <= 0n) {
    throw new Error("reference price must be positive");
  }

  const delta = value >= reference ? value - reference : reference - value;
  return (delta * 10_000n) / reference;
};
