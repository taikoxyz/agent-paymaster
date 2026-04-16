import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { PaymasterQuote } from "./paymaster-service.js";
import { PersistenceStore } from "./persistence.js";

function tempDbPath(): string {
  const dir = join(tmpdir(), `servo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return join(dir, "test.db");
}

describe("PersistenceStore", () => {
  const stores: PersistenceStore[] = [];
  const dirs: string[] = [];

  function createStore(dbPath?: string): PersistenceStore {
    const path = dbPath ?? tempDbPath();
    dirs.push(join(path, ".."));
    const store = new PersistenceStore(path);
    stores.push(store);
    return store;
  }

  afterEach(() => {
    for (const store of stores) {
      store.close();
    }
    stores.length = 0;
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  // ── Default path / DB creation ──────────────────────────────────────

  it("creates the database file at the specified path", () => {
    const dbPath = tempDbPath();
    createStore(dbPath);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("creates parent directories when they do not exist", () => {
    const dbPath = join(tmpdir(), `servo-nested-${Date.now()}`, "a", "b", "test.db");
    dirs.push(join(dbPath, "..", "..", ".."));
    const store = new PersistenceStore(dbPath);
    stores.push(store);
    expect(existsSync(dbPath)).toBe(true);
  });

  // ── Quote CRUD ──────────────────────────────────────────────────────

  describe("quote persistence", () => {
    const fakeQuote = (overrides: Record<string, unknown> = {}) =>
      ({
        quoteId: "q-1",
        chain: "taiko",
        chainId: 167000,
        token: "USDC",
        paymaster: "0xPM",
        paymasterData: "0xAA",
        paymasterAndData: "0xBB",
        callGasLimit: "0x1",
        verificationGasLimit: "0x2",
        preVerificationGas: "0x3",
        paymasterVerificationGasLimit: "0x4",
        paymasterPostOpGasLimit: "0x5",
        estimatedGasLimit: "0x6",
        estimatedGasWei: "0x7",
        maxTokenCostMicros: "100000",
        maxTokenCost: "0.1",
        validUntil: Math.floor(Date.now() / 1000) + 600,
        entryPoint: "0xEP",
        sender: "0xSENDER",
        tokenAddress: "0xUSDC",
        ...overrides,
      }) as unknown as PaymasterQuote;

    it("saves and retrieves a quote", () => {
      const store = createStore();
      const quote = fakeQuote();
      store.saveIssuedQuote("key-1", quote);

      const retrieved = store.getIssuedQuote("key-1");
      expect(retrieved).toEqual(quote);
    });

    it("returns null for a non-existent quote", () => {
      const store = createStore();
      expect(store.getIssuedQuote("does-not-exist")).toBeNull();
    });

    it("returns null and deletes an expired quote", () => {
      const store = createStore();
      const pastTime = Math.floor(Date.now() / 1000) - 10;
      const quote = fakeQuote({ validUntil: pastTime });
      store.saveIssuedQuote("expired-key", quote);

      const retrieved = store.getIssuedQuote("expired-key", pastTime + 1);
      expect(retrieved).toBeNull();

      // Verify it was actually deleted (second lookup also null)
      expect(store.getIssuedQuote("expired-key", pastTime - 100)).toBeNull();
    });

    it("overwrites a quote with the same key", () => {
      const store = createStore();
      const quote1 = fakeQuote({ maxTokenCost: "0.1" });
      const quote2 = fakeQuote({ maxTokenCost: "0.2" });

      store.saveIssuedQuote("key-ow", quote1);
      store.saveIssuedQuote("key-ow", quote2);

      const retrieved = store.getIssuedQuote("key-ow");
      expect(retrieved).toEqual(quote2);
    });
  });

  // ── Rate-limit bucket CRUD ──────────────────────────────────────────

  describe("rate-limit bucket persistence", () => {
    it("saves and retrieves a rate-limit bucket", () => {
      const store = createStore();
      store.setRateLimitBucket("rl-1", 5, 1000);

      const bucket = store.getRateLimitBucket("rl-1");
      expect(bucket).toEqual({ count: 5, windowStart: 1000 });
    });

    it("returns undefined for a non-existent bucket", () => {
      const store = createStore();
      expect(store.getRateLimitBucket("nope")).toBeUndefined();
    });

    it("overwrites an existing bucket", () => {
      const store = createStore();
      store.setRateLimitBucket("rl-2", 1, 100);
      store.setRateLimitBucket("rl-2", 10, 200);

      const bucket = store.getRateLimitBucket("rl-2");
      expect(bucket).toEqual({ count: 10, windowStart: 200 });
    });

    it("deletes a bucket", () => {
      const store = createStore();
      store.setRateLimitBucket("rl-del", 3, 500);
      store.deleteRateLimitBucket("rl-del");

      expect(store.getRateLimitBucket("rl-del")).toBeUndefined();
    });

    it("lists all buckets", () => {
      const store = createStore();
      store.setRateLimitBucket("a", 1, 100);
      store.setRateLimitBucket("b", 2, 200);

      const all = store.getAllRateLimitBuckets();
      expect(all).toHaveLength(2);
      expect(all).toEqual(
        expect.arrayContaining([
          { key: "a", count: 1, windowStart: 100 },
          { key: "b", count: 2, windowStart: 200 },
        ]),
      );
    });
  });
});
