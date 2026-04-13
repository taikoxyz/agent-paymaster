import { logEvent, RPC_RESOURCE_UNAVAILABLE } from "@agent-paymaster/shared";
import { BundlerRpcError } from "./rpc-parsing.js";

export interface SenderReputation {
  failures: number;
  windowStartedAt: number | null;
  throttledUntil: number | null;
  bannedUntil: number | null;
}

interface ReputationPersistence {
  saveSenderReputation(
    sender: string,
    failures: number,
    windowStartedAt: number | null,
    throttledUntil: number | null,
    bannedUntil: number | null,
  ): void;
  deleteSenderReputation(sender: string): void;
}

interface ReputationConfig {
  reputationBanFailures: number;
  reputationThrottleFailures: number;
  reputationWindowMs: number;
  throttleWindowMs: number;
  banWindowMs: number;
}

export class SenderReputationTracker {
  private readonly reputations = new Map<string, SenderReputation>();
  private readonly config: ReputationConfig;
  private readonly persistence?: ReputationPersistence;

  constructor(config: ReputationConfig, persistence?: ReputationPersistence) {
    this.config = config;
    this.persistence = persistence;
  }

  load(sender: string, reputation: SenderReputation): void {
    this.reputations.set(sender, reputation);
  }

  ensureCanSubmit(sender: string): void {
    const now = Date.now();
    const reputation = this.resolve(sender, now);
    if (!reputation) {
      return;
    }

    if (reputation.bannedUntil !== null && reputation.bannedUntil > now) {
      throw new BundlerRpcError(RPC_RESOURCE_UNAVAILABLE, "Sender is temporarily banned", {
        reason: "sender_banned",
        sender,
        bannedUntil: reputation.bannedUntil,
      });
    }

    if (reputation.throttledUntil !== null && reputation.throttledUntil > now) {
      throw new BundlerRpcError(RPC_RESOURCE_UNAVAILABLE, "Sender is temporarily throttled", {
        reason: "sender_throttled",
        sender,
        throttledUntil: reputation.throttledUntil,
        retryAfterMs: reputation.throttledUntil - now,
      });
    }
  }

  clear(sender: string): void {
    this.reputations.delete(sender);
    this.persistence?.deleteSenderReputation(sender);
  }

  recordDeterministicFailure(sender: string): void {
    const now = Date.now();
    const current = this.resolve(sender, now) ?? {
      failures: 0,
      windowStartedAt: now,
      throttledUntil: null,
      bannedUntil: null,
    };

    const nextFailures = current.failures + 1;
    const next: SenderReputation = {
      failures: nextFailures,
      windowStartedAt: current.windowStartedAt ?? now,
      throttledUntil: null,
      bannedUntil: null,
    };

    if (nextFailures >= this.config.reputationBanFailures) {
      next.bannedUntil = now + this.config.banWindowMs;
      logEvent("warn", "bundler.sender_banned", {
        sender,
        failures: nextFailures,
        bannedUntil: next.bannedUntil,
      });
    } else if (nextFailures >= this.config.reputationThrottleFailures) {
      next.throttledUntil = now + this.config.throttleWindowMs;
      logEvent("warn", "bundler.sender_throttled", {
        sender,
        failures: nextFailures,
        throttledUntil: next.throttledUntil,
      });
    } else {
      logEvent("warn", "bundler.sender_validation_warning", {
        sender,
        failures: nextFailures,
      });
    }

    this.reputations.set(sender, next);
    this.save(sender, next);
  }

  countBannedSenders(now: number): number {
    let count = 0;
    for (const reputation of this.reputations.values()) {
      if (reputation.bannedUntil !== null && reputation.bannedUntil > now) {
        count += 1;
      }
    }
    return count;
  }

  private resolve(sender: string, now: number): SenderReputation | null {
    const reputation = this.reputations.get(sender);
    if (!reputation) {
      return null;
    }

    if (
      reputation.windowStartedAt !== null &&
      now - reputation.windowStartedAt >= this.config.reputationWindowMs
    ) {
      this.clear(sender);
      return null;
    }

    let updated = false;
    if (reputation.bannedUntil !== null && reputation.bannedUntil <= now) {
      reputation.bannedUntil = null;
      updated = true;
    }
    if (reputation.throttledUntil !== null && reputation.throttledUntil <= now) {
      reputation.throttledUntil = null;
      updated = true;
    }

    if (
      reputation.failures <= 0 &&
      reputation.bannedUntil === null &&
      reputation.throttledUntil === null
    ) {
      this.clear(sender);
      return null;
    }

    if (updated) {
      this.save(sender, reputation);
    }

    return reputation;
  }

  private save(sender: string, reputation: SenderReputation): void {
    this.persistence?.saveSenderReputation(
      sender,
      reputation.failures,
      reputation.windowStartedAt,
      reputation.throttledUntil,
      reputation.bannedUntil,
    );
  }
}
