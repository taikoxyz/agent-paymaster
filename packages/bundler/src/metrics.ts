const MEMPOOL_AGE_BUCKETS_MS = [30_000, 60_000, 300_000, 900_000] as const;

const buildAgeBucketKeys = (): string[] => [
  ...MEMPOOL_AGE_BUCKETS_MS.map((bucket) => `le_${bucket}ms`),
  `gt_${MEMPOOL_AGE_BUCKETS_MS[MEMPOOL_AGE_BUCKETS_MS.length - 1]}ms`,
];

export const buildAgeBucketCounts = (): Record<string, number> =>
  Object.fromEntries(buildAgeBucketKeys().map((key) => [key, 0]));

export const recordAgeBucket = (buckets: Record<string, number>, ageMs: number): void => {
  for (const bucket of MEMPOOL_AGE_BUCKETS_MS) {
    if (ageMs <= bucket) {
      buckets[`le_${bucket}ms`] += 1;
      return;
    }
  }

  buckets[`gt_${MEMPOOL_AGE_BUCKETS_MS[MEMPOOL_AGE_BUCKETS_MS.length - 1]}ms`] += 1;
};

export const incrementReasonCounter = (counters: Map<string, number>, reason: string): void => {
  const normalized = reason.trim().replaceAll(/\s+/g, "_").slice(0, 120) || "unknown";
  counters.set(normalized, (counters.get(normalized) ?? 0) + 1);
};

export const reasonCountersToRecord = (counters: Map<string, number>): Record<string, number> =>
  Object.fromEntries([...counters.entries()].sort(([left], [right]) => left.localeCompare(right)));
