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
}

const DEFAULT_CONFIG: FixedWindowRateLimiterConfig = {
  maxRequestsPerWindow: 60,
  windowMs: 60_000,
};

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, FixedWindowBucket>();
  private readonly config: FixedWindowRateLimiterConfig;

  constructor(config: Partial<FixedWindowRateLimiterConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  consume(key: string, nowMs = Date.now()): RateLimitResult {
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
}
