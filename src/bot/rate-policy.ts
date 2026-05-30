import { createFixedWindowRateLimiter, type FixedWindowRateLimitResult } from '../rate-limit.js';
import type { PublicSearchAccessClass } from '../subscriptions/access.service.js';

export type PublicSearchRateLimitAction = 'message' | 'search' | 'season' | 'blocked-message';

export type PublicSearchRateLimitInput = {
  action: PublicSearchRateLimitAction;
  accessClass?: PublicSearchAccessClass | undefined;
  userId?: number | undefined;
};

export type PublicSearchInteractionRateLimiter = {
  check(input: PublicSearchRateLimitInput): FixedWindowRateLimitResult;
};

type RatePolicyOptions = {
  now?: () => number;
};

const WINDOW_MS = 60_000;

export function createPublicSearchInteractionRateLimiter(
  options: RatePolicyOptions = {}
): PublicSearchInteractionRateLimiter {
  const fixedWindowOptions = (limit: number) =>
    options.now === undefined ? { limit, windowMs: WINDOW_MS } : { limit, windowMs: WINDOW_MS, now: options.now };

  const messageLimiter = createFixedWindowRateLimiter(fixedWindowOptions(5));
  const paidSearchLimiter = createFixedWindowRateLimiter(fixedWindowOptions(10));
  const paidSeasonLimiter = createFixedWindowRateLimiter(fixedWindowOptions(20));
  const trialSearchLimiter = createFixedWindowRateLimiter(fixedWindowOptions(5));
  const trialSeasonLimiter = createFixedWindowRateLimiter(fixedWindowOptions(10));
  const blockedMessageLimiter = createFixedWindowRateLimiter(fixedWindowOptions(3));

  return {
    check(input) {
      const userKey = input.userId ?? 'unknown';

      if (input.action === 'message') {
        return messageLimiter.check(`message:${userKey}`);
      }

      if (input.action === 'blocked-message' || input.accessClass === 'blocked') {
        return blockedMessageLimiter.check(`blocked-message:${userKey}`);
      }

      if (input.action === 'search' && input.accessClass === 'paid') {
        return paidSearchLimiter.check(`paid:search:${userKey}`);
      }

      if (input.action === 'season' && input.accessClass === 'paid') {
        return paidSeasonLimiter.check(`paid:season:${userKey}`);
      }

      if (input.action === 'search' && input.accessClass === 'trial-active') {
        return trialSearchLimiter.check(`trial:search:${userKey}`);
      }

      if (input.action === 'season' && input.accessClass === 'trial-active') {
        return trialSeasonLimiter.check(`trial:season:${userKey}`);
      }

      return blockedMessageLimiter.check(`blocked-message:${userKey}`);
    }
  };
}
