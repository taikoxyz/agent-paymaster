import { describe, expect, it } from "vitest";

import {
  EXPENSIVE_METHODS,
  FixedWindowRateLimiter,
  LayeredRateLimiter,
  SenderChurnTracker,
} from "./rate-limit.js";

class FakePersistenceStore {
  readonly buckets = new Map<string, { count: number; windowStart: number }>();

  setRateLimitBucket(key: string, count: number, windowStart: number): void {
    this.buckets.set(key, { count, windowStart });
  }

  deleteRateLimitBucket(key: string): void {
    this.buckets.delete(key);
  }

  getAllRateLimitBuckets(): Array<{ key: string; count: number; windowStart: number }> {
    return [...this.buckets.entries()].map(([key, value]) => ({
      key,
      count: value.count,
      windowStart: value.windowStart,
    }));
  }

  deleteExpiredRateLimitBuckets(windowMs: number): void {
    const cutoff = Date.now() - windowMs;

    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.windowStart < cutoff) {
        this.buckets.delete(key);
      }
    }
  }
}

describe("fixed window rate limiter", () => {
  it("caps bucket growth at maxBuckets", () => {
    const limiter = new FixedWindowRateLimiter({
      maxRequestsPerWindow: 1,
      windowMs: 60_000,
      maxBuckets: 3,
    });

    limiter.consume("a", 0);
    limiter.consume("b", 0);
    limiter.consume("c", 0);
    expect(limiter.getBucketCount()).toBe(3);

    limiter.consume("d", 0);
    expect(limiter.getBucketCount()).toBe(3);
  });

  it("reclaims expired buckets when a new window starts", () => {
    const limiter = new FixedWindowRateLimiter({
      maxRequestsPerWindow: 1,
      windowMs: 100,
      maxBuckets: 2,
    });

    limiter.consume("a", 0);
    limiter.consume("b", 0);
    expect(limiter.getBucketCount()).toBe(2);

    limiter.consume("c", 101);
    expect(limiter.getBucketCount()).toBe(1);
  });

  it("persists bucket updates immediately and reloads them on startup", () => {
    const persistence = new FakePersistenceStore();
    const now = Date.now();
    const config = {
      maxRequestsPerWindow: 2,
      windowMs: 60_000,
      maxBuckets: 100,
    };

    const firstLimiter = new FixedWindowRateLimiter(config, persistence as never);
    firstLimiter.consume("sender:0xabc", now);
    firstLimiter.consume("sender:0xabc", now + 1);

    expect(persistence.buckets.get("sender:0xabc")).toEqual({
      count: 2,
      windowStart: now,
    });

    const secondLimiter = new FixedWindowRateLimiter(config, persistence as never);
    const result = secondLimiter.consume("sender:0xabc", now + 2);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Layered rate limiter
// ---------------------------------------------------------------------------

describe("layered rate limiter", () => {
  const makeLayered = (overrides: Record<string, unknown> = {}) =>
    new LayeredRateLimiter({
      ip: { maxRequestsPerWindow: 5, windowMs: 60_000 },
      sender: { maxRequestsPerWindow: 3, windowMs: 60_000 },
      global: { maxRequestsPerWindow: 10, windowMs: 60_000 },
      expensiveMethod: { maxRequestsPerWindow: 2, windowMs: 60_000 },
      ...overrides,
    });

  it("allows requests within all layer limits", () => {
    const limiter = makeLayered();
    const result = limiter.consume({ ip: "1.2.3.4", sender: "0xaaa", method: "eth_chainId" }, 0);
    expect(result.allowed).toBe(true);
    expect(result.rejectedLayer).toBeNull();
  });

  it("rejects when IP limit is exceeded", () => {
    const limiter = makeLayered();
    for (let i = 0; i < 5; i++) {
      const r = limiter.consume({ ip: "1.2.3.4", sender: null, method: "eth_chainId" }, 0);
      expect(r.allowed).toBe(true);
    }
    const rejected = limiter.consume({ ip: "1.2.3.4", sender: null, method: "eth_chainId" }, 0);
    expect(rejected.allowed).toBe(false);
    expect(rejected.rejectedLayer).toBe("ip");
  });

  it("rejects when sender limit is exceeded even if IP has budget", () => {
    const limiter = makeLayered();
    for (let i = 0; i < 3; i++) {
      const r = limiter.consume({ ip: "1.2.3.4", sender: "0xaaa", method: "eth_chainId" }, 0);
      expect(r.allowed).toBe(true);
    }
    const rejected = limiter.consume({ ip: "1.2.3.4", sender: "0xaaa", method: "eth_chainId" }, 0);
    expect(rejected.allowed).toBe(false);
    expect(rejected.rejectedLayer).toBe("sender");
  });

  it("rejects when global limit is exceeded", () => {
    const limiter = makeLayered({
      ip: { maxRequestsPerWindow: 100, windowMs: 60_000 },
      global: { maxRequestsPerWindow: 4, windowMs: 60_000 },
    });

    for (let i = 0; i < 4; i++) {
      const r = limiter.consume({ ip: `10.0.0.${i}`, sender: null, method: "eth_chainId" }, 0);
      expect(r.allowed).toBe(true);
    }
    const rejected = limiter.consume({ ip: "10.0.0.99", sender: null, method: "eth_chainId" }, 0);
    expect(rejected.allowed).toBe(false);
    expect(rejected.rejectedLayer).toBe("global");
  });

  it("rejects expensive methods at lower threshold per IP", () => {
    const limiter = makeLayered();
    // Two expensive method calls should succeed
    for (let i = 0; i < 2; i++) {
      const r = limiter.consume({ ip: "1.2.3.4", sender: null, method: "pm_getPaymasterData" }, 0);
      expect(r.allowed).toBe(true);
    }
    // Third expensive call is blocked by method layer
    const rejected = limiter.consume(
      { ip: "1.2.3.4", sender: null, method: "pm_getPaymasterData" },
      0,
    );
    expect(rejected.allowed).toBe(false);
    expect(rejected.rejectedLayer).toBe("method");
  });

  it("does not apply method budget to cheap methods", () => {
    const limiter = makeLayered({
      expensiveMethod: { maxRequestsPerWindow: 1, windowMs: 60_000 },
    });

    // Cheap method should not be constrained by method layer
    for (let i = 0; i < 5; i++) {
      const r = limiter.consume({ ip: "1.2.3.4", sender: null, method: "eth_chainId" }, 0);
      expect(r.allowed).toBe(true);
    }
  });

  it("rotating senders from one IP still gets constrained by IP bucket", () => {
    const limiter = makeLayered({
      ip: { maxRequestsPerWindow: 3, windowMs: 60_000 },
      sender: { maxRequestsPerWindow: 100, windowMs: 60_000 },
      expensiveMethod: { maxRequestsPerWindow: 100, windowMs: 60_000 },
    });

    // Each call uses a different sender — but same IP
    for (let i = 0; i < 3; i++) {
      const r = limiter.consume(
        {
          ip: "attacker-ip",
          sender: `0x${String(i).padStart(40, "0")}`,
          method: "pm_getPaymasterData",
        },
        0,
      );
      expect(r.allowed).toBe(true);
    }
    // 4th call with a fresh sender is still blocked by IP
    const rejected = limiter.consume(
      { ip: "attacker-ip", sender: "0x" + "f".repeat(40), method: "pm_getPaymasterData" },
      0,
    );
    expect(rejected.allowed).toBe(false);
    expect(rejected.rejectedLayer).toBe("ip");
  });

  it("different IPs get independent IP budgets", () => {
    const limiter = makeLayered();
    // Exhaust IP A
    for (let i = 0; i < 5; i++) {
      limiter.consume({ ip: "ip-a", sender: null, method: "eth_chainId" }, 0);
    }
    // IP B should still work
    const result = limiter.consume({ ip: "ip-b", sender: null, method: "eth_chainId" }, 0);
    expect(result.allowed).toBe(true);
    expect(result.rejectedLayer).toBeNull();
  });

  it("EXPENSIVE_METHODS set contains the expected methods", () => {
    expect(EXPENSIVE_METHODS.has("pm_getPaymasterData")).toBe(true);
    expect(EXPENSIVE_METHODS.has("pm_getPaymasterStubData")).toBe(true);
    expect(EXPENSIVE_METHODS.has("eth_estimateUserOperationGas")).toBe(true);
    expect(EXPENSIVE_METHODS.has("eth_chainId")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sender churn tracker
// ---------------------------------------------------------------------------

describe("sender churn tracker", () => {
  it("tracks distinct senders per IP within a window", () => {
    const tracker = new SenderChurnTracker(60_000);

    expect(tracker.record("1.2.3.4", "0xaaa", 0)).toBe(1);
    expect(tracker.record("1.2.3.4", "0xbbb", 1)).toBe(2);
    expect(tracker.record("1.2.3.4", "0xaaa", 2)).toBe(2); // duplicate
    expect(tracker.record("1.2.3.4", "0xccc", 3)).toBe(3);
  });

  it("resets counts when window expires", () => {
    const tracker = new SenderChurnTracker(100);

    tracker.record("1.2.3.4", "0xaaa", 0);
    tracker.record("1.2.3.4", "0xbbb", 50);
    expect(tracker.getCount("1.2.3.4", 50)).toBe(2);

    // After window expires, count resets
    expect(tracker.record("1.2.3.4", "0xccc", 101)).toBe(1);
    expect(tracker.getCount("1.2.3.4", 101)).toBe(1);
  });

  it("tracks IPs independently", () => {
    const tracker = new SenderChurnTracker(60_000);

    tracker.record("ip-a", "0xaaa", 0);
    tracker.record("ip-a", "0xbbb", 0);
    tracker.record("ip-b", "0xaaa", 0);

    expect(tracker.getCount("ip-a", 0)).toBe(2);
    expect(tracker.getCount("ip-b", 0)).toBe(1);
  });

  it("evicts oldest IP when at capacity", () => {
    const tracker = new SenderChurnTracker(60_000, 2);

    tracker.record("ip-a", "0xaaa", 0);
    tracker.record("ip-b", "0xbbb", 1);
    // At capacity — adding ip-c should evict ip-a (oldest)
    tracker.record("ip-c", "0xccc", 2);

    expect(tracker.getCount("ip-a", 2)).toBe(0);
    expect(tracker.getCount("ip-b", 2)).toBe(1);
    expect(tracker.getCount("ip-c", 2)).toBe(1);
  });
});
