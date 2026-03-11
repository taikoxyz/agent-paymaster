import { describe, expect, it } from "vitest";

import { FixedWindowRateLimiter } from "./rate-limit.js";

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
});
