import type { PersistenceStore } from "./persistence.js";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

interface FixedWindowBucket {
  windowStartMs: number;
  count: number;
}

export interface FixedWindowRateLimiterConfig {
  maxRequestsPerWindow: number;
  windowMs: number;
  maxBuckets: number;
}

const DEFAULT_CONFIG: FixedWindowRateLimiterConfig = {
  maxRequestsPerWindow: 60,
  windowMs: 60_000,
  maxBuckets: 10_000,
};

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, FixedWindowBucket>();
  private readonly config: FixedWindowRateLimiterConfig;
  private readonly persistence?: PersistenceStore;
  private operationCount = 0;

  constructor(config: Partial<FixedWindowRateLimiterConfig> = {}, persistence?: PersistenceStore) {
    const merged = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    this.config = {
      maxRequestsPerWindow:
        Number.isInteger(merged.maxRequestsPerWindow) && merged.maxRequestsPerWindow > 0
          ? merged.maxRequestsPerWindow
          : DEFAULT_CONFIG.maxRequestsPerWindow,
      windowMs:
        Number.isInteger(merged.windowMs) && merged.windowMs > 0
          ? merged.windowMs
          : DEFAULT_CONFIG.windowMs,
      maxBuckets:
        Number.isInteger(merged.maxBuckets) && merged.maxBuckets > 0
          ? merged.maxBuckets
          : DEFAULT_CONFIG.maxBuckets,
    };

    this.persistence = persistence;

    if (persistence) {
      this.loadFromPersistence(persistence);
    }
  }

  private loadFromPersistence(persistence: PersistenceStore): void {
    const now = Date.now();
    persistence.deleteExpiredRateLimitBuckets(this.config.windowMs);

    for (const row of persistence.getAllRateLimitBuckets()) {
      if (now < row.windowStart + this.config.windowMs) {
        this.buckets.set(row.key, {
          windowStartMs: row.windowStart,
          count: row.count,
        });
      }
    }
  }

  private sweepExpired(nowMs: number): void {
    for (const [bucketKey, bucket] of this.buckets.entries()) {
      if (nowMs >= bucket.windowStartMs + this.config.windowMs) {
        this.buckets.delete(bucketKey);
        this.persistence?.deleteRateLimitBucket(bucketKey);
      }
    }
  }

  private evictOldestBucket(): void {
    let oldestKey: string | null = null;
    let oldestWindowStart = Number.POSITIVE_INFINITY;

    for (const [bucketKey, bucket] of this.buckets.entries()) {
      if (bucket.windowStartMs < oldestWindowStart) {
        oldestWindowStart = bucket.windowStartMs;
        oldestKey = bucketKey;
      }
    }

    if (oldestKey !== null) {
      this.buckets.delete(oldestKey);
      this.persistence?.deleteRateLimitBucket(oldestKey);
    }
  }

  private enforceCapacity(key: string, nowMs: number): void {
    this.operationCount += 1;
    const shouldSweep =
      this.operationCount % 256 === 0 || this.buckets.size >= this.config.maxBuckets;

    if (shouldSweep) {
      this.sweepExpired(nowMs);
    }

    if (this.buckets.size >= this.config.maxBuckets && !this.buckets.has(key)) {
      this.evictOldestBucket();
    }
  }

  consume(key: string, nowMs = Date.now()): RateLimitResult {
    this.enforceCapacity(key, nowMs);

    const existing = this.buckets.get(key);

    if (existing === undefined || nowMs >= existing.windowStartMs + this.config.windowMs) {
      const nextWindowStart = nowMs;
      const nextBucket = {
        windowStartMs: nextWindowStart,
        count: 1,
      };
      this.buckets.set(key, nextBucket);
      this.persistence?.setRateLimitBucket(key, nextBucket.count, nextBucket.windowStartMs);

      return {
        allowed: true,
        limit: this.config.maxRequestsPerWindow,
        remaining: this.config.maxRequestsPerWindow - 1,
        resetAt: nextWindowStart + this.config.windowMs,
      };
    }

    if (existing.count >= this.config.maxRequestsPerWindow) {
      return {
        allowed: false,
        limit: this.config.maxRequestsPerWindow,
        remaining: 0,
        resetAt: existing.windowStartMs + this.config.windowMs,
      };
    }

    existing.count += 1;
    this.persistence?.setRateLimitBucket(key, existing.count, existing.windowStartMs);

    return {
      allowed: true,
      limit: this.config.maxRequestsPerWindow,
      remaining: this.config.maxRequestsPerWindow - existing.count,
      resetAt: existing.windowStartMs + this.config.windowMs,
    };
  }

  getBucketCount(): number {
    return this.buckets.size;
  }
}

// ---------------------------------------------------------------------------
// Expensive RPC methods that warrant tighter per-IP budgets
// ---------------------------------------------------------------------------

export const EXPENSIVE_METHODS = new Set([
  "pm_getPaymasterData",
  "pm_getPaymasterStubData",
  "eth_estimateUserOperationGas",
]);

// ---------------------------------------------------------------------------
// Layered rate limiter — enforces IP + sender + global + method budgets
// ---------------------------------------------------------------------------

export interface LayeredRateLimitConfig {
  /** Per-IP window config. Always checked. */
  ip: { maxRequestsPerWindow: number; windowMs: number };
  /** Per-sender window config. Checked when a valid sender is present. */
  sender: { maxRequestsPerWindow: number; windowMs: number };
  /** Global (all callers) window config. Backstop for distributed attacks. */
  global: { maxRequestsPerWindow: number; windowMs: number };
  /** Per-IP budget for expensive methods (pm_*, estimation). */
  expensiveMethod: { maxRequestsPerWindow: number; windowMs: number };
  /** Capacity limit shared across all internal limiters. */
  maxBuckets: number;
}

const DEFAULT_LAYERED_CONFIG: LayeredRateLimitConfig = {
  ip: { maxRequestsPerWindow: 60, windowMs: 60_000 },
  sender: { maxRequestsPerWindow: 30, windowMs: 60_000 },
  global: { maxRequestsPerWindow: 600, windowMs: 60_000 },
  expensiveMethod: { maxRequestsPerWindow: 20, windowMs: 60_000 },
  maxBuckets: 10_000,
};

export type RejectedLayer = "ip" | "sender" | "global" | "method" | null;

export interface LayeredRateLimitResult extends RateLimitResult {
  rejectedLayer: RejectedLayer;
}

export interface LayeredConsumeInput {
  ip: string;
  sender: string | null;
  method: string | null;
}

export class LayeredRateLimiter {
  private readonly ipLimiter: FixedWindowRateLimiter;
  private readonly senderLimiter: FixedWindowRateLimiter;
  private readonly globalLimiter: FixedWindowRateLimiter;
  private readonly methodLimiter: FixedWindowRateLimiter;

  constructor(config: Partial<LayeredRateLimitConfig> = {}) {
    const merged = { ...DEFAULT_LAYERED_CONFIG, ...config };
    const buckets = merged.maxBuckets;

    this.ipLimiter = new FixedWindowRateLimiter({
      ...merged.ip,
      maxBuckets: buckets,
    });

    this.senderLimiter = new FixedWindowRateLimiter({
      ...merged.sender,
      maxBuckets: buckets,
    });

    this.globalLimiter = new FixedWindowRateLimiter({
      maxRequestsPerWindow: merged.global.maxRequestsPerWindow,
      windowMs: merged.global.windowMs,
      maxBuckets: 1, // single global bucket
    });

    this.methodLimiter = new FixedWindowRateLimiter({
      ...merged.expensiveMethod,
      maxBuckets: buckets,
    });
  }

  consume(input: LayeredConsumeInput, nowMs = Date.now()): LayeredRateLimitResult {
    // Layer 1: global backstop
    const globalResult = this.globalLimiter.consume("global", nowMs);
    if (!globalResult.allowed) {
      return { ...globalResult, rejectedLayer: "global" };
    }

    // Layer 2: per-IP
    const ipResult = this.ipLimiter.consume(`ip:${input.ip}`, nowMs);
    if (!ipResult.allowed) {
      return { ...ipResult, rejectedLayer: "ip" };
    }

    // Layer 3: per-sender (when present)
    let senderResult: RateLimitResult | null = null;
    if (input.sender !== null) {
      senderResult = this.senderLimiter.consume(`sender:${input.sender}`, nowMs);
      if (!senderResult.allowed) {
        return { ...senderResult, rejectedLayer: "sender" };
      }
    }

    // Layer 4: expensive method budget (per-IP)
    if (input.method !== null && EXPENSIVE_METHODS.has(input.method)) {
      const methodResult = this.methodLimiter.consume(`method:${input.ip}`, nowMs);
      if (!methodResult.allowed) {
        return { ...methodResult, rejectedLayer: "method" };
      }
    }

    // All layers passed — return tightest remaining
    const tightest = this.tightestResult(ipResult, senderResult);
    return { ...tightest, rejectedLayer: null };
  }

  private tightestResult(a: RateLimitResult, b: RateLimitResult | null): RateLimitResult {
    if (b === null) return a;
    return a.remaining <= b.remaining ? a : b;
  }
}

// ---------------------------------------------------------------------------
// Sender churn tracker — counts distinct senders per IP per window
// ---------------------------------------------------------------------------

interface ChurnWindow {
  windowStartMs: number;
  senders: Set<string>;
}

export class SenderChurnTracker {
  private readonly windows = new Map<string, ChurnWindow>();
  private readonly windowMs: number;
  private readonly maxIps: number;

  constructor(windowMs = 60_000, maxIps = 10_000) {
    this.windowMs = windowMs;
    this.maxIps = maxIps;
  }

  /** Record a sender for an IP. Returns the distinct sender count in the current window. */
  record(ip: string, sender: string, nowMs = Date.now()): number {
    const existing = this.windows.get(ip);

    if (existing === undefined || nowMs >= existing.windowStartMs + this.windowMs) {
      // Enforce capacity before creating new entries
      if (this.windows.size >= this.maxIps && !this.windows.has(ip)) {
        this.evictOldest();
      }

      const window: ChurnWindow = {
        windowStartMs: nowMs,
        senders: new Set([sender]),
      };
      this.windows.set(ip, window);
      return 1;
    }

    existing.senders.add(sender);
    return existing.senders.size;
  }

  /** Get distinct sender count for an IP in the current window. */
  getCount(ip: string, nowMs = Date.now()): number {
    const existing = this.windows.get(ip);
    if (existing === undefined || nowMs >= existing.windowStartMs + this.windowMs) {
      return 0;
    }
    return existing.senders.size;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestStart = Number.POSITIVE_INFINITY;

    for (const [key, window] of this.windows.entries()) {
      if (window.windowStartMs < oldestStart) {
        oldestStart = window.windowStartMs;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.windows.delete(oldestKey);
    }
  }
}
