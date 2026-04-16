import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { BundlerPersistenceStore } from "./persistence.js";
import type { UserOperation } from "./types.js";

function tempDbPath(): string {
  const dir = join(tmpdir(), `bundler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return join(dir, "test.db");
}

const buildUserOperation = (overrides: Partial<UserOperation> = {}): UserOperation => ({
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "0x1",
  initCode: "0x",
  callData: "0x1234",
  maxFeePerGas: "0x100",
  maxPriorityFeePerGas: "0x10",
  signature: "0x99",
  ...overrides,
});

describe("BundlerPersistenceStore", () => {
  const stores: BundlerPersistenceStore[] = [];
  const dirs: string[] = [];

  function createStore(dbPath?: string): BundlerPersistenceStore {
    const path = dbPath ?? tempDbPath();
    dirs.push(join(path, ".."));
    const store = new BundlerPersistenceStore(path);
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

  // ── Database creation ──────────────────────────────────────────────

  it("creates the database file at the specified path", () => {
    const dbPath = tempDbPath();
    createStore(dbPath);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("creates parent directories when they do not exist", () => {
    const dbPath = join(tmpdir(), `bundler-nested-${Date.now()}`, "a", "b", "test.db");
    dirs.push(join(dbPath, "..", "..", ".."));
    const store = new BundlerPersistenceStore(dbPath);
    stores.push(store);
    expect(existsSync(dbPath)).toBe(true);
  });

  // ── Pending operations ─────────────────────────────────────────────

  describe("pending operations", () => {
    it("saves and loads a pending operation", () => {
      const store = createStore();
      const userOp = buildUserOperation();
      const entryPoint = "0x0000000071727de22e5e9d8baf0edac6f37da032" as const;
      const now = Date.now();

      store.savePendingOperation("hash-1", entryPoint, userOp, now);

      const loaded = store.loadPendingOperations();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual({
        hash: "hash-1",
        entryPoint,
        userOperation: userOp,
        receivedAt: now,
        state: "pending",
        submissionTxHash: null,
        submissionStartedAt: null,
      });
    });

    it("overwrites an existing pending operation with the same hash", () => {
      const store = createStore();
      const entryPoint = "0x0000000071727de22e5e9d8baf0edac6f37da032" as const;
      const now = Date.now();

      const userOp1 = buildUserOperation({ nonce: "0x1" });
      const userOp2 = buildUserOperation({ nonce: "0x2" });

      store.savePendingOperation("hash-dup", entryPoint, userOp1, now);
      store.savePendingOperation("hash-dup", entryPoint, userOp2, now + 100);

      const loaded = store.loadPendingOperations();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.userOperation.nonce).toBe("0x2");
      expect(loaded[0]!.receivedAt).toBe(now + 100);
    });

    it("removes a pending operation", () => {
      const store = createStore();
      const userOp = buildUserOperation();
      const entryPoint = "0x0000000071727de22e5e9d8baf0edac6f37da032" as const;

      store.savePendingOperation("hash-rm", entryPoint, userOp, Date.now());
      expect(store.loadPendingOperations()).toHaveLength(1);

      store.removePendingOperation("hash-rm");
      expect(store.loadPendingOperations()).toHaveLength(0);
    });

    it("removing a non-existent hash is a no-op", () => {
      const store = createStore();
      store.removePendingOperation("does-not-exist");
      expect(store.loadPendingOperations()).toHaveLength(0);
    });

    it("loads multiple pending operations", () => {
      const store = createStore();
      const entryPoint = "0x0000000071727de22e5e9d8baf0edac6f37da032" as const;
      const now = Date.now();

      store.savePendingOperation("h1", entryPoint, buildUserOperation({ nonce: "0x1" }), now);
      store.savePendingOperation("h2", entryPoint, buildUserOperation({ nonce: "0x2" }), now + 1);

      const loaded = store.loadPendingOperations();
      expect(loaded).toHaveLength(2);
      const hashes = loaded.map((op) => op.hash);
      expect(hashes).toContain("h1");
      expect(hashes).toContain("h2");
    });
  });

  // ── Sender reputations ─────────────────────────────────────────────

  describe("sender reputations", () => {
    it("saves and loads a sender reputation", () => {
      const store = createStore();
      const sender = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const now = Date.now();

      store.saveSenderReputation(sender, 3, now, now + 60_000, null);

      const loaded = store.loadSenderReputations();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual({
        sender,
        failures: 3,
        windowStartedAt: now,
        throttledUntil: now + 60_000,
        bannedUntil: null,
      });
    });

    it("overwrites an existing sender reputation", () => {
      const store = createStore();
      const sender = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const now = Date.now();

      store.saveSenderReputation(sender, 1, now, null, null);
      store.saveSenderReputation(sender, 5, now, now + 120_000, now + 300_000);

      const loaded = store.loadSenderReputations();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual({
        sender,
        failures: 5,
        windowStartedAt: now,
        throttledUntil: now + 120_000,
        bannedUntil: now + 300_000,
      });
    });

    it("loads multiple sender reputations", () => {
      const store = createStore();
      const now = Date.now();

      store.saveSenderReputation("0xaaaa", 1, now, null, null);
      store.saveSenderReputation("0xbbbb", 2, now, null, null);

      const loaded = store.loadSenderReputations();
      expect(loaded).toHaveLength(2);
      const senders = loaded.map((r) => r.sender);
      expect(senders).toContain("0xaaaa");
      expect(senders).toContain("0xbbbb");
    });

    it("returns an empty array when no reputations exist", () => {
      const store = createStore();
      expect(store.loadSenderReputations()).toEqual([]);
    });
  });
});
