import type { PublicSearchDatabase } from '../db/database.js';
import type { SubscriptionStatus, TelegramUserIdentity } from './repository.js';
import {
  consumeTrialSearchIfAllowed,
  getSubscriptionUser,
  startTrialIfEligible,
  upsertSeenTelegramUser,
  validateTrialSearchLimit
} from './repository.js';

export type SearchAccessResult =
  | {
      allowed: true;
      status: SubscriptionStatus;
      trialStarted: boolean;
      trialSearchesUsed?: number | undefined;
    }
  | {
      allowed: false;
      reason: 'subscription-required';
      status?: SubscriptionStatus | undefined;
      trialStarted: false;
    };

export type PublicSearchAccessClass = 'paid' | 'trial-active' | 'blocked';

export function evaluateSearchAccess(
  db: PublicSearchDatabase,
  input: {
    user: TelegramUserIdentity | undefined;
    now: Date;
    trialSearchLimit: number;
  }
): SearchAccessResult {
  if (!input.user) {
    return { allowed: false, reason: 'subscription-required', trialStarted: false };
  }

  validateTrialSearchLimit(input.trialSearchLimit);
  upsertSeenTelegramUser(db, input.user, input.now);
  const user = getSubscriptionUser(db, input.user.id);

  return evaluateExistingUser(user, input.trialSearchLimit);
}

export function classifyPublicSearchAccess(
  db: PublicSearchDatabase,
  input: {
    user: TelegramUserIdentity | undefined;
    trialSearchLimit: number;
  }
): PublicSearchAccessClass {
  validateTrialSearchLimit(input.trialSearchLimit);

  if (!input.user) {
    return 'blocked';
  }

  const user = getSubscriptionUser(db, input.user.id);
  if (!user) {
    return 'trial-active';
  }

  return classifyExistingUser(user, input.trialSearchLimit);
}

export function consumeSuccessfulSearchAccess(
  db: PublicSearchDatabase,
  input: {
    user: TelegramUserIdentity | undefined;
    now: Date;
    trialSearchLimit: number;
  }
): SearchAccessResult {
  if (!input.user) {
    return { allowed: false, reason: 'subscription-required', trialStarted: false };
  }

  validateTrialSearchLimit(input.trialSearchLimit);
  upsertSeenTelegramUser(db, input.user, input.now);
  const trial = startTrialIfEligible(db, input.user, input.now);
  const user = getSubscriptionUser(db, input.user.id);

  if (!user) {
    return { allowed: false, reason: 'subscription-required', trialStarted: false };
  }

  if (user.status === 'Kicked' || user.removedFromGroup) {
    return { allowed: false, reason: 'subscription-required', status: user.status, trialStarted: false };
  }

  if (user.status === 'Subscribe' || user.status === 'Needs Attention') {
    return { allowed: true, status: user.status, trialStarted: false };
  }

  if (user.status === 'Trial') {
    const consumed = consumeTrialSearchIfAllowed(db, input.user.id, input.now, input.trialSearchLimit);
    if (consumed) {
      return {
        allowed: true,
        status: 'Trial',
        trialStarted: trial.started,
        trialSearchesUsed: consumed.trialSearchesUsed
      };
    }

    return { allowed: false, reason: 'subscription-required', status: 'Trial', trialStarted: false };
  }

  return { allowed: false, reason: 'subscription-required', status: user.status, trialStarted: false };
}

function evaluateExistingUser(
  user: ReturnType<typeof getSubscriptionUser>,
  trialSearchLimit: number
): SearchAccessResult {
  if (!user) {
    return { allowed: false, reason: 'subscription-required', trialStarted: false };
  }

  if (user.status === 'Kicked' || user.removedFromGroup) {
    return { allowed: false, reason: 'subscription-required', status: user.status, trialStarted: false };
  }

  if (user.status === 'Subscribe' || user.status === 'Needs Attention') {
    return { allowed: true, status: user.status, trialStarted: false };
  }

  if (user.status === 'Trial' && user.trialSearchesUsed < trialSearchLimit) {
    return {
      allowed: true,
      status: 'Trial',
      trialStarted: false,
      trialSearchesUsed: user.trialSearchesUsed
    };
  }

  return { allowed: false, reason: 'subscription-required', status: user.status, trialStarted: false };
}

function classifyExistingUser(
  user: ReturnType<typeof getSubscriptionUser>,
  trialSearchLimit: number
): PublicSearchAccessClass {
  if (!user || user.status === 'Kicked' || user.removedFromGroup || user.status === 'Unpaid') {
    return 'blocked';
  }

  if (user.status === 'Subscribe' || user.status === 'Needs Attention') {
    return 'paid';
  }

  if (user.status === 'Trial' && user.trialSearchesUsed < trialSearchLimit) {
    return 'trial-active';
  }

  return 'blocked';
}
