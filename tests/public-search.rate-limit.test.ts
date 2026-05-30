import { describe, expect, it } from 'vitest';
import { createFixedWindowRateLimiter } from '../src/rate-limit.js';

describe('public search fixed-window rate limiter', () => {
  it('allows a user to make the configured number of interactions per window', () => {
    const limiter = createFixedWindowRateLimiter({
      limit: 3,
      windowMs: 1000,
      now: () => 100
    });

    expect(limiter.check('user-1')).toEqual({ allowed: true });
    expect(limiter.check('user-1')).toEqual({ allowed: true });
    expect(limiter.check('user-1')).toEqual({ allowed: true });
  });

  it('blocks the next interaction after the limit is reached', () => {
    const limiter = createFixedWindowRateLimiter({
      limit: 2,
      windowMs: 1000,
      now: () => 250
    });

    expect(limiter.check('user-1')).toEqual({ allowed: true });
    expect(limiter.check('user-1')).toEqual({ allowed: true });
    expect(limiter.check('user-1')).toEqual({ allowed: false, retryAfterMs: 1000 });
  });

  it('allows the same user again after the window expires', () => {
    let currentTime = 100;
    const limiter = createFixedWindowRateLimiter({
      limit: 1,
      windowMs: 1000,
      now: () => currentTime
    });

    expect(limiter.check('user-1')).toEqual({ allowed: true });
    expect(limiter.check('user-1')).toEqual({ allowed: false, retryAfterMs: 1000 });

    currentTime = 1099;
    expect(limiter.check('user-1')).toEqual({ allowed: false, retryAfterMs: 1 });

    currentTime = 1100;
    expect(limiter.check('user-1')).toEqual({ allowed: true });
  });

  it('tracks different users independently', () => {
    const limiter = createFixedWindowRateLimiter({
      limit: 1,
      windowMs: 1000,
      now: () => 500
    });

    expect(limiter.check('user-1')).toEqual({ allowed: true });
    expect(limiter.check('user-1')).toEqual({ allowed: false, retryAfterMs: 1000 });
    expect(limiter.check('user-2')).toEqual({ allowed: true });
  });

  it('prunes expired buckets during checks', () => {
    let currentTime = 100;
    const limiter = createFixedWindowRateLimiter({
      limit: 1,
      windowMs: 1000,
      now: () => currentTime
    });

    expect(limiter.check('user-1')).toEqual({ allowed: true });
    expect(limiter.check('user-2')).toEqual({ allowed: true });
    expect(limiter.debugBucketCount()).toBe(2);

    currentTime = 1100;
    expect(limiter.check('user-3')).toEqual({ allowed: true });

    expect(limiter.debugBucketCount()).toBe(1);
    expect(limiter.check('user-1')).toEqual({ allowed: true });
    expect(limiter.debugBucketCount()).toBe(2);
  });

  it('requires integer limit and window size values', () => {
    expect(() =>
      createFixedWindowRateLimiter({
        limit: 1.5,
        windowMs: 1000
      })
    ).toThrow('Rate limit must be a positive integer');

    expect(() =>
      createFixedWindowRateLimiter({
        limit: 1,
        windowMs: 1000.5
      })
    ).toThrow('Rate limit windowMs must be a positive integer');
  });
});
