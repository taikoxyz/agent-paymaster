import {
  DEFAULT_TAIKO_RPC_URL,
  SERVO_TAIKO_ENTRY_POINT_V07,
  WEI_PER_ETH,
} from "@agent-paymaster/shared";

const DEPOSITS_SELECTOR = "0xfc7e286d";
const DEFAULT_LOW_THRESHOLD_WEI = 2_000_000_000_000_000n; // 0.002 ETH (~9 ops)
const DEFAULT_CRITICAL_THRESHOLD_WEI = 500_000_000_000_000n; // 0.0005 ETH (~2 ops)
const MONITOR_TIMEOUT_MS = 3_000;
const ABI_WORD_HEX_LENGTH = 64;

type DepositStatus = "ok" | "low" | "critical" | "unknown";

export interface DepositHealth {
  status: DepositStatus;
  balanceEth?: string;
  balanceWei?: string;
  error?: string;
}

interface EntryPointMonitorConfig {
  taikoRpcUrl?: string;
  paymasterAddress: string;
  entryPointAddress?: string;
  lowThresholdWei?: bigint;
  criticalThresholdWei?: bigint;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const formatEth = (wei: bigint): string => {
  const whole = wei / WEI_PER_ETH;
  const fraction = wei % WEI_PER_ETH;
  return `${whole}.${fraction.toString().padStart(18, "0")}`;
};

const parseDepositBalanceWei = (rpcResult: string): bigint | null => {
  if (!rpcResult.startsWith("0x")) {
    return null;
  }

  const payload = rpcResult.slice(2);
  if (payload.length === 0) {
    return 0n;
  }

  if (payload.length <= ABI_WORD_HEX_LENGTH) {
    return BigInt(`0x${payload}`);
  }

  if (payload.length % ABI_WORD_HEX_LENGTH !== 0) {
    return null;
  }

  return BigInt(`0x${payload.slice(0, ABI_WORD_HEX_LENGTH)}`);
};

export class EntryPointMonitor {
  private readonly rpcUrl: string;
  private readonly paymasterAddress: string;
  private readonly entryPointAddress: string;
  private readonly lowThresholdWei: bigint;
  private readonly criticalThresholdWei: bigint;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: EntryPointMonitorConfig) {
    this.rpcUrl = config.taikoRpcUrl ?? DEFAULT_TAIKO_RPC_URL;
    this.paymasterAddress = config.paymasterAddress.toLowerCase();
    this.entryPointAddress = config.entryPointAddress ?? SERVO_TAIKO_ENTRY_POINT_V07;
    this.lowThresholdWei = config.lowThresholdWei ?? DEFAULT_LOW_THRESHOLD_WEI;
    this.criticalThresholdWei = config.criticalThresholdWei ?? DEFAULT_CRITICAL_THRESHOLD_WEI;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? MONITOR_TIMEOUT_MS;
  }

  async checkDeposit(): Promise<DepositHealth> {
    const calldata = `${DEPOSITS_SELECTOR}${this.paymasterAddress.slice(2).padStart(64, "0")}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "ep-deposit",
          method: "eth_call",
          params: [{ to: this.entryPointAddress, data: calldata }, "latest"],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return { status: "unknown", error: `HTTP ${response.status}` };
      }

      const body = (await response.json()) as { result?: string; error?: { message?: string } };

      if (body.error !== undefined) {
        return { status: "unknown", error: body.error.message ?? "rpc_error" };
      }

      if (typeof body.result !== "string") {
        return { status: "unknown", error: "invalid_response" };
      }

      const balanceWei = parseDepositBalanceWei(body.result);
      if (balanceWei === null) {
        return { status: "unknown", error: "invalid_response" };
      }

      const status: DepositStatus =
        balanceWei <= this.criticalThresholdWei
          ? "critical"
          : balanceWei <= this.lowThresholdWei
            ? "low"
            : "ok";

      return {
        status,
        balanceEth: formatEth(balanceWei),
        balanceWei: balanceWei.toString(),
      };
    } catch (error) {
      return {
        status: "unknown",
        error: error instanceof Error ? error.message : "fetch_failed",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
