export interface DependencyHealth {
  status: "ok" | "degraded";
  latencyMs: number;
  details?: unknown;
  error?: string;
}
