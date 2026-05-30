import { describe, expect, it } from 'vitest';
import { createPublicSearchDatabase } from '../src/db/database.js';
import { migratePublicSearchDatabase } from '../src/db/migrate.js';
import { applySubscriptionStartDate } from '../src/subscriptions/repository.js';
import {
  classifyPublicSearchAccess,
  consumeSuccessfulSearchAccess,
  evaluateSearchAccess
} from '../src/subscriptions/access.service.js';

function createDb() {
  const db = createPublicSearchDatabase(':memory:');
  migratePublicSearchDatabase(db);
  return db;
}

describe('subscription access service', () => {
  it('starts a search quota trial on first successful search', () => {
    const db = createDb();
    try {
      const result = consumeSuccessfulSearchAccess(db, {
        user: { id: 42, username: 'trial_user' },
        now: new Date('2026-05-26T00:00:00.000Z'),
        trialSearchLimit: 5
      });

      expect(result).toMatchObject({
        allowed: true,
        status: 'Trial',
        trialStarted: true,
        trialSearchesUsed: 1
      });
    } finally {
      db.close();
    }
  });

  it('blocks trial users after the configured successful search limit', () => {
    const db = createDb();
    try {
      for (let index = 0; index < 5; index += 1) {
        expect(
          consumeSuccessfulSearchAccess(db, {
            user: { id: 42, username: 'trial_user' },
            now: new Date(`2026-05-26T00:0${index}:00.000Z`),
            trialSearchLimit: 5
          })
        ).toMatchObject({ allowed: true, status: 'Trial', trialSearchesUsed: index + 1 });
      }

      expect(
        consumeSuccessfulSearchAccess(db, {
          user: { id: 42, username: 'trial_user' },
          now: new Date('2026-05-26T00:06:00.000Z'),
          trialSearchLimit: 5
        })
      ).toMatchObject({ allowed: false, reason: 'subscription-required', status: 'Trial' });
    } finally {
      db.close();
    }
  });

  it('allows active paid users and blocks kicked users', () => {
    const db = createDb();
    try {
      consumeSuccessfulSearchAccess(db, {
        user: { id: 42, username: 'paid_user' },
        now: new Date('2026-05-26T00:00:00.000Z'),
        trialSearchLimit: 5
      });
      applySubscriptionStartDate(db, 42, '2026-05-26', 1, new Date('2026-05-26T00:00:00.000Z'));

      expect(
        consumeSuccessfulSearchAccess(db, {
          user: { id: 42, username: 'paid_user' },
          now: new Date('2026-06-25T00:00:00.000Z'),
          trialSearchLimit: 5
        })
      ).toMatchObject({ allowed: true, status: 'Subscribe' });

      db.prepare("UPDATE subscription_users SET status = 'Kicked', removed_from_group = 1 WHERE telegram_user_id = 42").run();

      expect(
        consumeSuccessfulSearchAccess(db, {
          user: { id: 42, username: 'paid_user' },
          now: new Date('2026-06-25T01:00:00.000Z'),
          trialSearchLimit: 5
        })
      ).toMatchObject({ allowed: false, reason: 'subscription-required', status: 'Kicked' });
    } finally {
      db.close();
    }
  });

  it('blocks non-consuming access after the trial search quota is exhausted', () => {
    const db = createDb();
    try {
      for (let index = 0; index < 5; index += 1) {
        consumeSuccessfulSearchAccess(db, {
          user: { id: 42, username: 'trial_user' },
          now: new Date(`2026-05-26T00:0${index}:00.000Z`),
          trialSearchLimit: 5
        });
      }

      expect(
        evaluateSearchAccess(db, {
          user: { id: 42, username: 'trial_user' },
          now: new Date('2026-05-26T00:10:00.000Z'),
          trialSearchLimit: 5
        })
      ).toMatchObject({ allowed: false, reason: 'subscription-required', status: 'Trial' });
    } finally {
      db.close();
    }
  });

  it('classifies new, paid, exhausted trial, and removed users for rate limits without consuming quota', () => {
    const db = createDb();
    try {
      const now = new Date('2026-05-26T00:00:00.000Z');

      expect(
        classifyPublicSearchAccess(db, {
          user: { id: 42, username: 'new_user' },
          trialSearchLimit: 5
        })
      ).toBe('trial-active');

      expect(db.prepare('SELECT COUNT(*) AS count FROM subscription_users').get()).toEqual({ count: 0 });

      consumeSuccessfulSearchAccess(db, {
        user: { id: 43, username: 'paid_user' },
        now,
        trialSearchLimit: 5
      });
      applySubscriptionStartDate(db, 43, '2026-05-26', 1, now);

      expect(
        classifyPublicSearchAccess(db, {
          user: { id: 43, username: 'paid_user' },
          trialSearchLimit: 5
        })
      ).toBe('paid');

      for (let index = 0; index < 5; index += 1) {
        consumeSuccessfulSearchAccess(db, {
          user: { id: 44, username: 'trial_user' },
          now: new Date(`2026-05-26T00:1${index}:00.000Z`),
          trialSearchLimit: 5
        });
      }

      expect(
        classifyPublicSearchAccess(db, {
          user: { id: 44, username: 'trial_user' },
          trialSearchLimit: 5
        })
      ).toBe('blocked');

      db.prepare('UPDATE subscription_users SET removed_from_group = 1 WHERE telegram_user_id = 43').run();

      expect(
        classifyPublicSearchAccess(db, {
          user: { id: 43, username: 'paid_user' },
          trialSearchLimit: 5
        })
      ).toBe('blocked');
    } finally {
      db.close();
    }
  });

  it('validates trial search limits before classifying missing users', () => {
    const db = createDb();
    try {
      expect(() =>
        classifyPublicSearchAccess(db, {
          user: undefined,
          trialSearchLimit: 0
        })
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
