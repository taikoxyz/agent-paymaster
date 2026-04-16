import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type { PaymasterQuote } from "./paymaster-service.js";

const DEFAULT_DB_PATH = "./data/api.db";

export class PersistenceStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = process.env.DB_PATH ?? DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issued_quotes (
        quote_key TEXT PRIMARY KEY,
        quote_json TEXT NOT NULL,
        valid_until INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        window_start INTEGER NOT NULL
      );
    `);

    this.deleteExpiredQuotes();
  }

  getIssuedQuote(
    quoteKey: string,
    nowSeconds: number = Math.floor(Date.now() / 1000),
  ): PaymasterQuote | null {
    const row = this.db
      .prepare("SELECT quote_json, valid_until FROM issued_quotes WHERE quote_key = ?")
      .get(quoteKey) as { quote_json: string; valid_until: number } | undefined;

    if (!row) {
      return null;
    }

    if (row.valid_until <= nowSeconds) {
      this.db.prepare("DELETE FROM issued_quotes WHERE quote_key = ?").run(quoteKey);
      return null;
    }

    return JSON.parse(row.quote_json) as PaymasterQuote;
  }

  saveIssuedQuote(quoteKey: string, quote: PaymasterQuote): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO issued_quotes (quote_key, quote_json, valid_until, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(quoteKey, JSON.stringify(quote), quote.validUntil, Date.now());
  }

  getRateLimitBucket(key: string): { count: number; windowStart: number } | undefined {
    const row = this.db
      .prepare("SELECT count, window_start FROM rate_limit_buckets WHERE key = ?")
      .get(key) as { count: number; window_start: number } | undefined;

    if (!row) return undefined;
    return { count: row.count, windowStart: row.window_start };
  }

  setRateLimitBucket(key: string, count: number, windowStart: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO rate_limit_buckets (key, count, window_start) VALUES (?, ?, ?)",
      )
      .run(key, count, windowStart);
  }

  deleteRateLimitBucket(key: string): void {
    this.db.prepare("DELETE FROM rate_limit_buckets WHERE key = ?").run(key);
  }

  getAllRateLimitBuckets(): Array<{ key: string; count: number; windowStart: number }> {
    const rows = this.db
      .prepare("SELECT key, count, window_start FROM rate_limit_buckets")
      .all() as Array<{ key: string; count: number; window_start: number }>;

    return rows.map((row) => ({
      key: row.key,
      count: row.count,
      windowStart: row.window_start,
    }));
  }

  deleteExpiredRateLimitBuckets(windowMs: number): void {
    const cutoff = Date.now() - windowMs;
    this.db.prepare("DELETE FROM rate_limit_buckets WHERE window_start < ?").run(cutoff);
  }

  deleteExpiredQuotes(nowSeconds: number = Math.floor(Date.now() / 1000)): void {
    this.db.prepare("DELETE FROM issued_quotes WHERE valid_until <= ?").run(nowSeconds);
  }

  cleanupExpired(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;

    const quotesResult = this.db
      .prepare("DELETE FROM issued_quotes WHERE created_at < ?")
      .run(cutoff);
    const bucketsResult = this.db
      .prepare("DELETE FROM rate_limit_buckets WHERE window_start < ?")
      .run(cutoff);

    return quotesResult.changes + bucketsResult.changes;
  }

  close(): void {
    this.db.close();
  }
}
