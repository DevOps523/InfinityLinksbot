import { describe, expect, it, vi } from 'vitest';
import { evaluateSearchAccess } from '../src/subscriptions/access.service.js';
import {
  consumeTrialSearchIfAllowed,
  getSubscriptionUser,
  startTrialIfEligible,
  upsertSeenTelegramUser,
  validateTrialSearchLimit
} from '../src/subscriptions/repository.js';

vi.mock('../src/subscriptions/repository.js', () => ({
  consumeTrialSearchIfAllowed: vi.fn(),
  getSubscriptionUser: vi.fn(),
  startTrialIfEligible: vi.fn(),
  upsertSeenTelegramUser: vi.fn(),
  validateTrialSearchLimit: vi.fn()
}));

describe('subscription access username refresh', () => {
  it('refreshes usernames from public bot interactions', () => {
    const db = {};
    const now = new Date('2026-05-26T00:00:00.000Z');
    vi.mocked(startTrialIfEligible).mockReturnValue({
      started: false,
      user: {
        telegramUserId: 42,
        username: 'new_name',
        status: 'Subscribe',
        removedFromGroup: false,
        trialSearchesUsed: 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      }
    });
    vi.mocked(getSubscriptionUser).mockReturnValue({
      telegramUserId: 42,
      username: 'new_name',
      status: 'Subscribe',
      removedFromGroup: false,
      trialSearchesUsed: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    });
    vi.mocked(validateTrialSearchLimit).mockImplementation((trialSearchLimit: number) => {
      if (!Number.isInteger(trialSearchLimit) || trialSearchLimit <= 0) {
        throw new Error('Trial search limit must be a positive integer');
      }
    });

    expect(
      evaluateSearchAccess(db as never, {
        user: { id: 42, username: 'new_name' },
        now,
        trialSearchLimit: 5
      })
    ).toMatchObject({ allowed: true, status: 'Subscribe' });

    expect(upsertSeenTelegramUser).toHaveBeenCalledWith(db, { id: 42, username: 'new_name' }, now);
  });
});
