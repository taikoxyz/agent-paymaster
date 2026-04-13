import { DEFAULT_TAIKO_RPC_URL, bigIntToHex } from "@agent-paymaster/shared";

import type { GasPriceGuidance, GasPriceOracle } from "./paymaster-service.js";
import { median } from "./price-provider.js";

const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 2_000;
/**
 * Minimum tip to ensure transactions are picked up (0.001 gwei).
 * Taiko's actual median tip is 0 gwei (network is near-empty), but we
 * set a small floor so the suggested fee is never literally zero.
 */
const MIN_PRIORITY_FEE_WEI = 1_000_000n;
/** Number of recent blocks to sample for fee history. */
const FEE_HISTORY_BLOCK_COUNT = 10;
/** Percentile of recent priority fees to use (50th = median). */
const FEE_HISTORY_PERCENTILE = 50;

interface RpcGasPriceOracleConfig {
  rpcUrl?: string;
  cacheTtlMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetches gas price data from a chain RPC and caches it briefly.
 *
 * Uses `eth_feeHistory` instead of `eth_maxPriorityFeePerGas` because
 * the latter returns a wildly inflated value on low-traffic L2s like
 * Taiko (e.g. 0.675 gwei when actual median tip is 0).
 *
 * Returns a `GasPriceGuidance` with:
 * - `baseFeePerGas`: current block base fee
 * - `suggestedMaxFeePerGas`: 2 × baseFee + median tip (safe for 2 blocks)
 * - `suggestedMaxPriorityFeePerGas`: median tip from recent blocks
 */
export class RpcGasPriceOracle implements GasPriceOracle {
  private readonly rpcUrl: string;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  private cachedGuidance: GasPriceGuidance | null = null;
  private cacheExpiresAt = 0;

  constructor(config: RpcGasPriceOracleConfig = {}) {
    this.rpcUrl = config.rpcUrl ?? DEFAULT_TAIKO_RPC_URL;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async getGasPriceGuidance(): Promise<GasPriceGuidance | null> {
    if (this.cachedGuidance !== null && Date.now() < this.cacheExpiresAt) {
      return this.cachedGuidance;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const feeHistory = await this.rpcCall(
        "eth_feeHistory",
        [`0x${FEE_HISTORY_BLOCK_COUNT.toString(16)}`, "latest", [FEE_HISTORY_PERCENTILE]],
        controller.signal,
      );

      const parsed = this.parseFeeHistory(feeHistory);
      if (parsed === null) {
        return null;
      }

      const suggestedMaxFee = parsed.baseFee * 2n + parsed.medianTip;

      const guidance: GasPriceGuidance = {
        baseFeePerGas: bigIntToHex(parsed.baseFee),
        suggestedMaxFeePerGas: bigIntToHex(suggestedMaxFee),
        suggestedMaxPriorityFeePerGas: bigIntToHex(parsed.medianTip),
        fetchedAt: new Date().toISOString(),
      };

      this.cachedGuidance = guidance;
      this.cacheExpiresAt = Date.now() + this.cacheTtlMs;

      return guidance;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async rpcCall(method: string, params: unknown[], signal: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`RPC returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as { result?: unknown; error?: unknown };
    if (body.error !== undefined) {
      throw new Error(`RPC error: ${JSON.stringify(body.error)}`);
    }

    return body.result;
  }

  /**
   * Parses `eth_feeHistory` response to extract:
   * - baseFee: the most recent block's base fee (last element, which is
   *   the *next* block's predicted base fee)
   * - medianTip: median of the 50th-percentile reward values across sampled blocks
   */
  private parseFeeHistory(result: unknown): { baseFee: bigint; medianTip: bigint } | null {
    if (result === null || typeof result !== "object") {
      return null;
    }

    const history = result as {
      baseFeePerGas?: string[];
      reward?: string[][];
    };

    const baseFees = history.baseFeePerGas;
    if (!Array.isArray(baseFees) || baseFees.length === 0) {
      return null;
    }

    // baseFeePerGas has N+1 entries; the last is the predicted next-block base fee
    const latestBaseFeeHex = baseFees[baseFees.length - 1];
    if (typeof latestBaseFeeHex !== "string" || !latestBaseFeeHex.startsWith("0x")) {
      return null;
    }

    const baseFee = BigInt(latestBaseFeeHex);

    // Extract the median (50th percentile) tip from each block, then take the
    // median of those medians for a stable estimate.
    const rewards = history.reward;
    let medianTip = MIN_PRIORITY_FEE_WEI;

    if (Array.isArray(rewards) && rewards.length > 0) {
      const tips: bigint[] = [];
      for (const blockRewards of rewards) {
        if (Array.isArray(blockRewards) && blockRewards.length > 0) {
          const tipHex = blockRewards[0]; // 50th percentile (only percentile requested)
          if (typeof tipHex === "string" && tipHex.startsWith("0x")) {
            tips.push(BigInt(tipHex));
          }
        }
      }

      if (tips.length > 0) {
        const rawMedian = median(tips);
        medianTip = rawMedian > MIN_PRIORITY_FEE_WEI ? rawMedian : MIN_PRIORITY_FEE_WEI;
      }
    }

    return { baseFee, medianTip };
  }
}
