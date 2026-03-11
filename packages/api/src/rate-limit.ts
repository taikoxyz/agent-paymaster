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
  private operationCount = 0;

  constructor(config: Partial<FixedWindowRateLimiterConfig> = {}) {
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
  }

  private sweepExpired(nowMs: number): void {
    for (const [bucketKey, bucket] of this.buckets.entries()) {
      if (nowMs >= bucket.windowStartMs + this.config.windowMs) {
        this.buckets.delete(bucketKey);
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
      this.buckets.set(key, {
        windowStartMs: nextWindowStart,
        count: 1,
      });

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
