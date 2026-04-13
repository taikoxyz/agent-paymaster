import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type { HexString } from "@agent-paymaster/shared";

import type { UserOperation, UserOperationReceiptLog } from "./types.js";

const DEFAULT_DB_PATH = "./data/servo.db";

export class BundlerPersistenceStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = process.env.DB_PATH ?? DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_user_operations (
        hash TEXT PRIMARY KEY,
        entry_point TEXT NOT NULL,
        user_operation TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        submission_tx_hash TEXT,
        submission_started_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS finalized_user_operations (
        hash TEXT PRIMARY KEY,
        entry_point TEXT NOT NULL,
        user_operation TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        finalized_at INTEGER NOT NULL,
        transaction_hash TEXT,
        block_number INTEGER,
        block_hash TEXT,
        reason TEXT,
        gas_used TEXT,
        gas_cost TEXT,
        effective_gas_price TEXT,
        receipt_logs TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_finalized_user_operations_finalized_at
        ON finalized_user_operations(finalized_at);

      CREATE TABLE IF NOT EXISTS sender_reputations (
        sender TEXT PRIMARY KEY,
        failures INTEGER NOT NULL,
        window_started_at INTEGER,
        throttled_until INTEGER,
        banned_until INTEGER
      );
    `);

    this.ensureColumns("pending_user_operations", [
      { name: "state", definition: "TEXT NOT NULL DEFAULT 'pending'" },
      { name: "submission_tx_hash", definition: "TEXT" },
      { name: "submission_started_at", definition: "INTEGER" },
    ]);
    this.ensureColumns("finalized_user_operations", [{ name: "receipt_logs", definition: "TEXT" }]);
    this.ensureColumns("sender_reputations", [
      { name: "window_started_at", definition: "INTEGER" },
      { name: "throttled_until", definition: "INTEGER" },
    ]);
    this.deleteExpiredSenderReputations();
  }

  private ensureColumns(table: string, columns: Array<{ name: string; definition: string }>): void {
    const existing = new Set(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );

    for (const column of columns) {
      if (!existing.has(column.name)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.definition}`);
      }
    }
  }

  savePendingOperation(
    hash: string,
    entryPoint: HexString,
    userOperation: UserOperation,
    receivedAt: number,
  ): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO pending_user_operations (hash, entry_point, user_operation, received_at, state, submission_tx_hash, submission_started_at) VALUES (?, ?, ?, ?, 'pending', NULL, NULL)",
      )
      .run(hash, entryPoint, JSON.stringify(userOperation), receivedAt);
  }

  markPendingOperationSubmitting(hash: string, startedAt: number): void {
    this.db
      .prepare(
        "UPDATE pending_user_operations SET state = 'submitting', submission_started_at = ?, submission_tx_hash = NULL WHERE hash = ?",
      )
      .run(startedAt, hash);
  }

  recordPendingOperationsTransactionHash(hashes: string[], transactionHash: HexString): void {
    if (hashes.length === 0) {
      return;
    }

    const update = this.db.prepare(
      "UPDATE pending_user_operations SET state = 'submitting', submission_tx_hash = ? WHERE hash = ?",
    );
    const writeBatch = this.db.transaction((pendingHashes: string[], hashValue: HexString) => {
      for (const hash of pendingHashes) {
        update.run(hashValue, hash);
      }
    });

    writeBatch(hashes, transactionHash);
  }

  markPendingOperationPending(hash: string): void {
    this.db
      .prepare(
        "UPDATE pending_user_operations SET state = 'pending', submission_tx_hash = NULL, submission_started_at = NULL WHERE hash = ?",
      )
      .run(hash);
  }

  removePendingOperation(hash: string): void {
    this.db.prepare("DELETE FROM pending_user_operations WHERE hash = ?").run(hash);
  }

  loadPendingOperations(): Array<{
    hash: string;
    entryPoint: HexString;
    userOperation: UserOperation;
    receivedAt: number;
    state: "pending" | "submitting";
    submissionTxHash: HexString | null;
    submissionStartedAt: number | null;
  }> {
    const rows = this.db
      .prepare(
        "SELECT hash, entry_point, user_operation, received_at, state, submission_tx_hash, submission_started_at FROM pending_user_operations",
      )
      .all() as Array<{
      hash: string;
      entry_point: string;
      user_operation: string;
      received_at: number;
      state: string;
      submission_tx_hash: string | null;
      submission_started_at: number | null;
    }>;

    return rows.map((row) => ({
      hash: row.hash,
      entryPoint: row.entry_point as HexString,
      userOperation: JSON.parse(row.user_operation) as UserOperation,
      receivedAt: row.received_at,
      state: row.state === "submitting" ? "submitting" : "pending",
      submissionTxHash: row.submission_tx_hash as HexString | null,
      submissionStartedAt: row.submission_started_at,
    }));
  }

  saveFinalizedOperation(operation: {
    hash: string;
    entryPoint: HexString;
    userOperation: UserOperation;
    receivedAt: number;
    state: "included" | "failed";
    finalizedAt: number;
    transactionHash: HexString | null;
    blockNumber: number | null;
    blockHash: HexString | null;
    reason: string | null;
    gasUsed: bigint | null;
    gasCost: bigint | null;
    effectiveGasPrice: bigint | null;
    receiptLogs: UserOperationReceiptLog[] | null;
  }): void {
    this.db
      .prepare(
        `
          INSERT OR REPLACE INTO finalized_user_operations (
            hash,
            entry_point,
            user_operation,
            received_at,
            state,
            finalized_at,
            transaction_hash,
            block_number,
            block_hash,
            reason,
            gas_used,
            gas_cost,
            effective_gas_price,
            receipt_logs
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        operation.hash,
        operation.entryPoint,
        JSON.stringify(operation.userOperation),
        operation.receivedAt,
        operation.state,
        operation.finalizedAt,
        operation.transactionHash,
        operation.blockNumber,
        operation.blockHash,
        operation.reason,
        operation.gasUsed === null ? null : operation.gasUsed.toString(),
        operation.gasCost === null ? null : operation.gasCost.toString(),
        operation.effectiveGasPrice === null ? null : operation.effectiveGasPrice.toString(),
        operation.receiptLogs === null ? null : JSON.stringify(operation.receiptLogs),
      );
  }

  deleteFinalizedOperation(hash: string): void {
    this.db.prepare("DELETE FROM finalized_user_operations WHERE hash = ?").run(hash);
  }

  loadFinalizedOperations(): Array<{
    hash: string;
    entryPoint: HexString;
    userOperation: UserOperation;
    receivedAt: number;
    state: "included" | "failed";
    finalizedAt: number;
    transactionHash: HexString | null;
    blockNumber: number | null;
    blockHash: HexString | null;
    reason: string | null;
    gasUsed: bigint | null;
    gasCost: bigint | null;
    effectiveGasPrice: bigint | null;
    receiptLogs: UserOperationReceiptLog[] | null;
  }> {
    const rows = this.db
      .prepare(
        `
          SELECT
            hash,
            entry_point,
            user_operation,
            received_at,
            state,
            finalized_at,
            transaction_hash,
            block_number,
            block_hash,
            reason,
            gas_used,
            gas_cost,
            effective_gas_price,
            receipt_logs
          FROM finalized_user_operations
          ORDER BY finalized_at DESC
        `,
      )
      .all() as Array<{
      hash: string;
      entry_point: string;
      user_operation: string;
      received_at: number;
      state: string;
      finalized_at: number;
      transaction_hash: string | null;
      block_number: number | null;
      block_hash: string | null;
      reason: string | null;
      gas_used: string | null;
      gas_cost: string | null;
      effective_gas_price: string | null;
      receipt_logs: string | null;
    }>;

    return rows
      .filter((row) => row.state === "included" || row.state === "failed")
      .map((row) => ({
        hash: row.hash,
        entryPoint: row.entry_point as HexString,
        userOperation: JSON.parse(row.user_operation) as UserOperation,
        receivedAt: row.received_at,
        state: row.state as "included" | "failed",
        finalizedAt: row.finalized_at,
        transactionHash: row.transaction_hash as HexString | null,
        blockNumber: row.block_number,
        blockHash: row.block_hash as HexString | null,
        reason: row.reason,
        gasUsed: row.gas_used === null ? null : BigInt(row.gas_used),
        gasCost: row.gas_cost === null ? null : BigInt(row.gas_cost),
        effectiveGasPrice:
          row.effective_gas_price === null ? null : BigInt(row.effective_gas_price),
        receiptLogs:
          row.receipt_logs === null
            ? null
            : (JSON.parse(row.receipt_logs) as UserOperationReceiptLog[]),
      }));
  }

  pruneFinalizedOperations(maxEntries: number): string[] {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      return [];
    }

    const hashesToDelete = this.db
      .prepare(
        `
          SELECT hash
          FROM finalized_user_operations
          ORDER BY finalized_at DESC
          LIMIT -1 OFFSET ?
        `,
      )
      .all(maxEntries) as Array<{ hash: string }>;

    if (hashesToDelete.length === 0) {
      return [];
    }

    const deleteStatement = this.db.prepare("DELETE FROM finalized_user_operations WHERE hash = ?");
    const deleteBatch = this.db.transaction((hashes: string[]) => {
      for (const hash of hashes) {
        deleteStatement.run(hash);
      }
    });

    const deletedHashes = hashesToDelete.map((row) => row.hash);
    deleteBatch(deletedHashes);
    return deletedHashes;
  }

  saveSenderReputation(
    sender: string,
    failures: number,
    windowStartedAt: number | null,
    throttledUntil: number | null,
    bannedUntil: number | null,
  ): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO sender_reputations (sender, failures, window_started_at, throttled_until, banned_until) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sender, failures, windowStartedAt, throttledUntil, bannedUntil);
  }

  deleteSenderReputation(sender: string): void {
    this.db.prepare("DELETE FROM sender_reputations WHERE sender = ?").run(sender);
  }

  loadSenderReputations(): Array<{
    sender: string;
    failures: number;
    windowStartedAt: number | null;
    throttledUntil: number | null;
    bannedUntil: number | null;
  }> {
    const rows = this.db
      .prepare(
        "SELECT sender, failures, window_started_at, throttled_until, banned_until FROM sender_reputations",
      )
      .all() as Array<{
      sender: string;
      failures: number;
      window_started_at: number | null;
      throttled_until: number | null;
      banned_until: number | null;
    }>;

    return rows.map((row) => ({
      sender: row.sender,
      failures: row.failures,
      windowStartedAt: row.window_started_at,
      throttledUntil: row.throttled_until,
      bannedUntil: row.banned_until,
    }));
  }

  deleteExpiredSenderReputations(nowMs: number = Date.now()): void {
    this.db
      .prepare(
        "DELETE FROM sender_reputations WHERE (banned_until IS NOT NULL AND banned_until <= ?) AND (throttled_until IS NULL OR throttled_until <= ?)",
      )
      .run(nowMs, nowMs);
  }

  close(): void {
    this.db.close();
  }
}
