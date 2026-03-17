const formatLabels = (labels: Record<string, string>): string => {
  const entries = Object.entries(labels)
    .map(([key, value]) => `${key}="${value.replaceAll('"', '\\"')}"`)
    .join(",");

  return `{${entries}}`;
};

const buildMapKey = (labels: Record<string, string>): string =>
  Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("|");

interface CounterRecord {
  labels: Record<string, string>;
  value: number;
}

interface SummaryRecord {
  labels: Record<string, string>;
  count: number;
  sum: number;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, CounterRecord>();
  private readonly summaries = new Map<string, SummaryRecord>();

  incrementCounter(name: string, labels: Record<string, string>, amount = 1): void {
    const key = `${name}|${buildMapKey(labels)}`;
    const existing = this.counters.get(key);

    if (existing === undefined) {
      this.counters.set(key, { labels, value: amount });
      return;
    }

    existing.value += amount;
  }

  observeSummary(name: string, labels: Record<string, string>, value: number): void {
    const key = `${name}|${buildMapKey(labels)}`;
    const existing = this.summaries.get(key);

    if (existing === undefined) {
      this.summaries.set(key, {
        labels,
        count: 1,
        sum: value,
      });
      return;
    }

    existing.count += 1;
    existing.sum += value;
  }

  recordHttp(method: string, route: string, statusCode: number, durationMs: number): void {
    this.incrementCounter(
      "api_http_requests_total",
      {
        method,
        route,
        status: String(statusCode),
      },
      1,
    );

    this.observeSummary(
      "api_http_request_duration_ms",
      {
        method,
        route,
      },
      durationMs,
    );
  }

  recordRpc(method: string, result: "ok" | "error"): void {
    this.incrementCounter(
      "api_jsonrpc_requests_total",
      {
        method,
        result,
      },
      1,
    );
  }

  recordRateLimit(endpoint: string, layer = "single"): void {
    this.incrementCounter(
      "api_rate_limit_hits_total",
      {
        endpoint,
        layer,
      },
      1,
    );
  }

  recordSenderChurn(ip: string, distinctSenders: number): void {
    this.observeSummary(
      "api_sender_churn_per_ip",
      { ip: ip.length > 39 ? ip.slice(0, 39) : ip },
      distinctSenders,
    );
  }

  recordExpensiveMethodRequest(method: string): void {
    this.incrementCounter("api_expensive_method_requests_total", { method }, 1);
  }

  recordQuote(chain: string, result: "ok" | "error"): void {
    this.incrementCounter(
      "api_paymaster_quotes_total",
      {
        chain,
        result,
      },
      1,
    );
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    const counterMetadata: Array<{ name: string; help: string }> = [
      { name: "api_http_requests_total", help: "Total HTTP requests handled by API gateway" },
      {
        name: "api_jsonrpc_requests_total",
        help: "Total JSON-RPC requests handled by API gateway",
      },
      { name: "api_rate_limit_hits_total", help: "Total requests rejected by rate limiting" },
      {
        name: "api_expensive_method_requests_total",
        help: "Total requests for expensive RPC methods",
      },
      { name: "api_paymaster_quotes_total", help: "Total paymaster quote attempts" },
    ];
    const summaryMetadata: Array<{ name: string; help: string }> = [
      { name: "api_http_request_duration_ms", help: "API request durations in milliseconds" },
      { name: "api_sender_churn_per_ip", help: "Distinct senders per IP per window" },
    ];

    for (const metric of counterMetadata) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} counter`);

      for (const [nameKey, record] of this.counters.entries()) {
        const [name] = nameKey.split("|", 2);
        if (name === metric.name) {
          lines.push(`${name}${formatLabels(record.labels)} ${record.value}`);
        }
      }
    }

    for (const metric of summaryMetadata) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} summary`);

      for (const [nameKey, record] of this.summaries.entries()) {
        const [name] = nameKey.split("|", 2);
        if (name === metric.name) {
          lines.push(`${name}_count${formatLabels(record.labels)} ${record.count}`);
          lines.push(`${name}_sum${formatLabels(record.labels)} ${record.sum.toFixed(3)}`);
        }
      }
    }

    return `${lines.join("\n")}\n`;
  }

  snapshot(): Record<string, number> {
    const snapshot: Record<string, number> = {};

    for (const [key, record] of this.counters.entries()) {
      snapshot[key] = record.value;
    }

    for (const [key, record] of this.summaries.entries()) {
      snapshot[`${key}|count`] = record.count;
      snapshot[`${key}|sum`] = Number(record.sum.toFixed(3));
    }

    return snapshot;
  }

  getCounterSum(name: string, labels: Record<string, string> = {}): number {
    let total = 0;

    for (const [nameKey, record] of this.counters.entries()) {
      const [recordName] = nameKey.split("|", 2);
      if (recordName !== name) {
        continue;
      }

      const hasAllLabels = Object.entries(labels).every(
        ([key, value]) => record.labels[key] === value,
      );
      if (!hasAllLabels) {
        continue;
      }

      total += record.value;
    }

    return total;
  }
}
