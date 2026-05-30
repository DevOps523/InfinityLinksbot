import { describe, expect, it } from 'vitest';
import { createPublicSearchInteractionRateLimiter } from '../src/bot/rate-policy.js';

describe('public search bot rate policy', () => {
  it('allows 5 generic messages per minute', () => {
    let now = 0;
    const limiter = createPublicSearchInteractionRateLimiter({ now: () => now });

    for (let index = 0; index < 5; index += 1) {
      expect(limiter.check({ action: 'message', userId: 42 })).toEqual({ allowed: true });
    }
    expect(limiter.check({ action: 'message', userId: 42 })).toEqual({
      allowed: false,
      retryAfterMs: 60_000
    });

    now = 60_000;
    expect(limiter.check({ action: 'message', userId: 42 })).toEqual({ allowed: true });
  });

  it('allows paid users 10 searches and 20 season callbacks per minute', () => {
    let now = 0;
    const limiter = createPublicSearchInteractionRateLimiter({ now: () => now });

    for (let index = 0; index < 10; index += 1) {
      expect(limiter.check({ action: 'search', accessClass: 'paid', userId: 42 })).toEqual({ allowed: true });
    }
    expect(limiter.check({ action: 'search', accessClass: 'paid', userId: 42 })).toEqual({
      allowed: false,
      retryAfterMs: 60_000
    });

    for (let index = 0; index < 20; index += 1) {
      expect(limiter.check({ action: 'season', accessClass: 'paid', userId: 42 })).toEqual({ allowed: true });
    }
    expect(limiter.check({ action: 'season', accessClass: 'paid', userId: 42 })).toEqual({
      allowed: false,
      retryAfterMs: 60_000
    });

    now = 60_000;
    expect(limiter.check({ action: 'search', accessClass: 'paid', userId: 42 })).toEqual({ allowed: true });
    expect(limiter.check({ action: 'season', accessClass: 'paid', userId: 42 })).toEqual({ allowed: true });
  });

  it('uses stricter trial and blocked-message buckets', () => {
    const limiter = createPublicSearchInteractionRateLimiter({ now: () => 0 });

    for (let index = 0; index < 5; index += 1) {
      expect(limiter.check({ action: 'search', accessClass: 'trial-active', userId: 42 })).toEqual({ allowed: true });
    }
    expect(limiter.check({ action: 'search', accessClass: 'trial-active', userId: 42 })).toEqual({
      allowed: false,
      retryAfterMs: 60_000
    });

    for (let index = 0; index < 10; index += 1) {
      expect(limiter.check({ action: 'season', accessClass: 'trial-active', userId: 42 })).toEqual({ allowed: true });
    }
    expect(limiter.check({ action: 'season', accessClass: 'trial-active', userId: 42 })).toEqual({
      allowed: false,
      retryAfterMs: 60_000
    });

    for (let index = 0; index < 3; index += 1) {
      expect(limiter.check({ action: 'blocked-message', accessClass: 'blocked', userId: 42 })).toEqual({ allowed: true });
    }
    expect(limiter.check({ action: 'blocked-message', accessClass: 'blocked', userId: 42 })).toEqual({
      allowed: false,
      retryAfterMs: 60_000
    });
  });

  it('keeps users and action buckets isolated', () => {
    const limiter = createPublicSearchInteractionRateLimiter({ now: () => 0 });

    for (let index = 0; index < 10; index += 1) {
      expect(limiter.check({ action: 'search', accessClass: 'paid', userId: 42 })).toEqual({ allowed: true });
    }

    expect(limiter.check({ action: 'search', accessClass: 'paid', userId: 43 })).toEqual({ allowed: true });
    expect(limiter.check({ action: 'season', accessClass: 'paid', userId: 42 })).toEqual({ allowed: true });
  });

  it('keeps paid and trial search buckets isolated for the same user', () => {
    const limiter = createPublicSearchInteractionRateLimiter({ now: () => 0 });

    for (let index = 0; index < 10; index += 1) {
      expect(limiter.check({ action: 'search', accessClass: 'paid', userId: 42 })).toEqual({ allowed: true });
    }

    for (let index = 0; index < 5; index += 1) {
      expect(limiter.check({ action: 'search', accessClass: 'trial-active', userId: 42 })).toEqual({ allowed: true });
    }
    expect(limiter.check({ action: 'search', accessClass: 'trial-active', userId: 42 })).toEqual({
      allowed: false,
      retryAfterMs: 60_000
    });
  });
});
