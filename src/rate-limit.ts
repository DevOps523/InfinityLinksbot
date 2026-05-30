export type FixedWindowRateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

type RateLimitBucket = {
  count: number;
  windowStart: number;
};

export function createFixedWindowRateLimiter(options: { limit: number; windowMs: number; now?: () => number }) {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error('Rate limit must be a positive integer');
  }

  if (!Number.isInteger(options.windowMs) || options.windowMs <= 0) {
    throw new Error('Rate limit windowMs must be a positive integer');
  }

  const limit = options.limit;
  const windowMs = options.windowMs;
  const now = options.now ?? Date.now;
  const buckets = new Map<string, RateLimitBucket>();

  function pruneExpiredBuckets(currentTime: number) {
    for (const [key, bucket] of buckets) {
      if (currentTime >= bucket.windowStart + windowMs) {
        buckets.delete(key);
      }
    }
  }

  return {
    check(key: string): FixedWindowRateLimitResult {
      const currentTime = now();
      pruneExpiredBuckets(currentTime);

      const existing = buckets.get(key);

      if (!existing) {
        buckets.set(key, {
          count: 1,
          windowStart: currentTime
        });
        return { allowed: true };
      }

      if (existing.count >= limit) {
        return {
          allowed: false,
          retryAfterMs: existing.windowStart + windowMs - currentTime
        };
      }

      existing.count += 1;
      return { allowed: true };
    },

    debugBucketCount(): number {
      return buckets.size;
    }
  };
}
