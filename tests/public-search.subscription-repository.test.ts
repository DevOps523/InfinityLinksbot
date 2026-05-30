import { describe, expect, it } from 'vitest';
import { createPublicSearchDatabase } from '../src/db/database.js';
import { migratePublicSearchDatabase } from '../src/db/migrate.js';
import {
  addDateMonths,
  calculateDaysRemaining,
  todayDateString
} from '../src/subscriptions/date.js';
import {
  applySubscriptionStartDate,
  consumeTrialSearchIfAllowed,
  getSubscriptionUser,
  isKickStillDue,
  listActiveSubscriptionRows,
  listKickCandidates,
  listUsersNeedingAlert,
  markSubscriptionUserKickedIfStillDue,
  markSubscriptionUserKicked,
  recalculateSubscriptions,
  startTrialIfEligible,
  upsertSeenTelegramUser
} from '../src/subscriptions/repository.js';

function createDb() {
  const db = createPublicSearchDatabase(':memory:');
  migratePublicSearchDatabase(db);
  return db;
}

describe('subscription repository', () => {
  it('uses date-only math for calendar-month subscriptions', () => {
    expect(addDateMonths('2026-05-26', 1)).toBe('2026-06-26');
    expect(calculateDaysRemaining('2026-06-26', '2026-05-26')).toBe(31);
    expect(calculateDaysRemaining('2026-06-26', '2026-06-25')).toBe(1);
    expect(calculateDaysRemaining('2026-06-26', '2026-06-26')).toBe(0);
    expect(todayDateString(new Date('2026-05-26T16:00:00.000Z'))).toBe('2026-05-26');
    expect(() => addDateMonths('2026-02-31', 1)).toThrow(/Invalid date-only value/);
  });

  it('starts one quota trial once and keeps username keyed by user id', () => {
    const db = createDb();
    try {
      const first = startTrialIfEligible(db, { id: 42, username: 'first_name' }, new Date('2026-05-26T00:00:00.000Z'));
      const second = startTrialIfEligible(db, { id: 42, username: 'new_name' }, new Date('2026-05-26T01:00:00.000Z'));

      expect(first.started).toBe(true);
      expect(second.started).toBe(false);
      expect(second.user).toMatchObject({
        telegramUserId: 42,
        username: 'new_name',
        status: 'Trial',
        trialStartedAt: '2026-05-26T00:00:00.000Z',
        trialExpiresAt: undefined,
        trialSearchesUsed: 0
      });
    } finally {
      db.close();
    }
  });

  it('consumes trial searches only up to the configured limit', () => {
    const db = createDb();
    try {
      startTrialIfEligible(db, { id: 42, username: 'trial_user' }, new Date('2026-05-26T00:00:00.000Z'));

      expect(consumeTrialSearchIfAllowed(db, 42, new Date('2026-05-26T00:01:00.000Z'), 2)).toMatchObject({
        trialSearchesUsed: 1
      });
      expect(consumeTrialSearchIfAllowed(db, 42, new Date('2026-05-26T00:02:00.000Z'), 2)).toMatchObject({
        trialSearchesUsed: 2
      });
      expect(consumeTrialSearchIfAllowed(db, 42, new Date('2026-05-26T00:03:00.000Z'), 2)).toBeUndefined();
      expect(getSubscriptionUser(db, 42)).toMatchObject({ trialSearchesUsed: 2 });
    } finally {
      db.close();
    }
  });

  it('applies a manual paid start date and recalculates alert statuses', () => {
    const db = createDb();
    try {
      upsertSeenTelegramUser(db, { id: 42, username: 'paid_user' }, new Date('2026-05-26T00:00:00.000Z'));

      const paid = applySubscriptionStartDate(db, 42, '2026-05-26', 1, new Date('2026-05-26T00:00:00.000Z'));
      expect(paid).toMatchObject({
        subscriptionStartDate: '2026-05-26',
        subscriptionPlanMonths: 1,
        subscriptionEndDate: '2026-06-26',
        daysRemaining: 31,
        status: 'Subscribe'
      });

      recalculateSubscriptions(db, '2026-06-25');
      expect(listUsersNeedingAlert(db).map((user) => user.telegramUserId)).toEqual([42]);
      expect(listActiveSubscriptionRows(db)[0]).toMatchObject({
        username: 'paid_user',
        daysRemaining: 1,
        status: 'Needs Attention'
      });

      recalculateSubscriptions(db, '2026-06-26');
      expect(listUsersNeedingAlert(db)[0]).toMatchObject({
        telegramUserId: 42,
        status: 'Unpaid',
        unpaidSince: '2026-06-26'
      });
      expect(listKickCandidates(db, '2026-06-27', 1).map((user) => user.telegramUserId)).toEqual([42]);
      expect(isKickStillDue(db, 42, '2026-06-27', 1)).toBe(true);

      applySubscriptionStartDate(db, 42, '2026-06-27', 1, new Date('2026-06-27T01:00:00.000Z'));
      expect(isKickStillDue(db, 42, '2026-06-27', 1)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('accepts legacy paid period arguments while using one-month plan calculations', () => {
    const db = createDb();
    try {
      upsertSeenTelegramUser(db, { id: 42, username: 'paid_user' }, new Date('2026-05-26T00:00:00.000Z'));

      const paid = applySubscriptionStartDate(db, 42, '2026-05-26', 1, new Date('2026-05-26T00:00:00.000Z'));

      expect(paid).toMatchObject({
        subscriptionPlanMonths: 1,
        subscriptionEndDate: '2026-06-26',
        daysRemaining: 31
      });

      recalculateSubscriptions(db, '2026-06-25');
      expect(getSubscriptionUser(db, 42)).toMatchObject({
        subscriptionPlanMonths: 1,
        daysRemaining: 1,
        status: 'Needs Attention'
      });
    } finally {
      db.close();
    }
  });

  it.each([
    [1, '2026-06-26', 31],
    [3, '2026-08-26', 92],
    [6, '2026-11-26', 184]
  ] as const)('calculates a %i-month paid plan from 2026-05-26', (planMonths, expectedEndDate, expectedDaysRemaining) => {
    const db = createDb();
    try {
      upsertSeenTelegramUser(db, { id: 40 + planMonths, username: `paid_${planMonths}` }, new Date('2026-05-26T00:00:00.000Z'));

      expect(
        applySubscriptionStartDate(
          db,
          40 + planMonths,
          '2026-05-26',
          planMonths,
          new Date('2026-05-26T00:00:00.000Z')
        )
      ).toMatchObject({
        subscriptionPlanMonths: planMonths,
        subscriptionEndDate: expectedEndDate,
        daysRemaining: expectedDaysRemaining,
        status: 'Subscribe'
      });
    } finally {
      db.close();
    }
  });

  it('recalculates each user from their stored subscription plan duration', () => {
    const db = createDb();
    try {
      for (const planMonths of [1, 3, 6] as const) {
        upsertSeenTelegramUser(
          db,
          { id: 40 + planMonths, username: `paid_${planMonths}` },
          new Date('2026-05-26T00:00:00.000Z')
        );
        applySubscriptionStartDate(
          db,
          40 + planMonths,
          '2026-05-26',
          planMonths,
          new Date('2026-05-26T00:00:00.000Z')
        );
      }

      recalculateSubscriptions(db, '2026-06-26');

      expect(listActiveSubscriptionRows(db)).toMatchObject([
        {
          telegramUserId: 41,
          subscriptionPlanMonths: 1,
          subscriptionEndDate: '2026-06-26',
          daysRemaining: 0,
          status: 'Unpaid',
          unpaidSince: '2026-06-26'
        },
        {
          telegramUserId: 43,
          subscriptionPlanMonths: 3,
          subscriptionEndDate: '2026-08-26',
          daysRemaining: 61,
          status: 'Subscribe',
          unpaidSince: undefined
        },
        {
          telegramUserId: 46,
          subscriptionPlanMonths: 6,
          subscriptionEndDate: '2026-11-26',
          daysRemaining: 153,
          status: 'Subscribe',
          unpaidSince: undefined
        }
      ]);
    } finally {
      db.close();
    }
  });

  it('requires an existing user before applying a paid start date', () => {
    const db = createDb();
    try {
      expect(() => applySubscriptionStartDate(db, 42, '2026-05-26', 1, new Date('2026-05-26T00:00:00.000Z'))).toThrow(
        /Subscription user 42 does not exist/
      );
    } finally {
      db.close();
    }
  });

  it('rejects invalid paid subscription plan months', () => {
    const db = createDb();
    try {
      upsertSeenTelegramUser(db, { id: 42, username: 'paid_user' }, new Date('2026-05-26T00:00:00.000Z'));

      for (const planMonths of [0, -1, 2, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
        expect(() =>
          applySubscriptionStartDate(db, 42, '2026-05-26', planMonths, new Date('2026-05-26T00:00:00.000Z'))
        ).toThrow(
          /Subscription plan months must be 1, 3, or 6/
        );
      }
    } finally {
      db.close();
    }
  });

  it('rejects invalid recalculation dates before reading subscription rows', () => {
    const db = createDb();
    try {
      expect(() => recalculateSubscriptions(db, '2026-02-31')).toThrow(/Invalid date-only value/);
    } finally {
      db.close();
    }
  });

  it('enforces removed from group as a boolean on fresh migrated databases', () => {
    const db = createDb();
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO subscription_users (
               telegram_user_id,
               status,
               removed_from_group,
               created_at,
               updated_at
             )
             VALUES (42, 'Unpaid', 2, '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z')`
          )
          .run()
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('rebuilds legacy subscription users tables with the removed from group boolean constraint', () => {
    const db = createPublicSearchDatabase(':memory:');
    try {
      db.exec(`
        CREATE TABLE subscription_users (
          telegram_user_id INTEGER PRIMARY KEY,
          username TEXT,
          trial_started_at TEXT,
          trial_expires_at TEXT,
          subscription_start_date TEXT,
          subscription_end_date TEXT,
          days_remaining INTEGER,
          status TEXT NOT NULL DEFAULT 'Unpaid',
          unpaid_since TEXT,
          kicked_at TEXT,
          removed_from_group INTEGER NOT NULL DEFAULT 0,
          last_seen_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO subscription_users (
          telegram_user_id,
          username,
          status,
          removed_from_group,
          created_at,
          updated_at
        )
        VALUES (42, 'legacy_user', 'Unpaid', 2, '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z');
      `);

      migratePublicSearchDatabase(db);

      const row = db
        .prepare('SELECT removed_from_group AS removedFromGroup FROM subscription_users WHERE telegram_user_id = 42')
        .get() as { removedFromGroup: number };

      expect(row.removedFromGroup).toBe(0);
      expect(() =>
        db
          .prepare(
            `INSERT INTO subscription_users (
               telegram_user_id,
               status,
               removed_from_group,
               created_at,
               updated_at
             )
             VALUES (43, 'Unpaid', 2, '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z')`
          )
          .run()
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('adds trial search usage to legacy subscription users tables', () => {
    const db = createPublicSearchDatabase(':memory:');
    try {
      db.exec(`
        CREATE TABLE subscription_users (
          telegram_user_id INTEGER PRIMARY KEY,
          username TEXT,
          trial_started_at TEXT,
          trial_expires_at TEXT,
          subscription_start_date TEXT,
          subscription_end_date TEXT,
          days_remaining INTEGER,
          status TEXT NOT NULL DEFAULT 'Unpaid'
            CHECK (status IN ('Trial', 'Subscribe', 'Needs Attention', 'Unpaid', 'Kicked')),
          unpaid_since TEXT,
          kicked_at TEXT,
          history_exported_at TEXT,
          removed_from_group INTEGER NOT NULL DEFAULT 0 CHECK (removed_from_group IN (0, 1)),
          last_seen_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO subscription_users (
          telegram_user_id,
          username,
          status,
          removed_from_group,
          created_at,
          updated_at
        )
        VALUES (42, 'legacy_user', 'Trial', 0, '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z');
      `);

      migratePublicSearchDatabase(db);

      expect(getSubscriptionUser(db, 42)).toMatchObject({
        telegramUserId: 42,
        trialSearchesUsed: 0
      });
    } finally {
      db.close();
    }
  });

  it('marks kicked users without deleting permanent history', () => {
    const db = createDb();
    try {
      upsertSeenTelegramUser(db, { id: 42, username: 'late_user' }, new Date('2026-05-26T00:00:00.000Z'));
      applySubscriptionStartDate(db, 42, '2026-05-26', 1, new Date('2026-05-26T00:00:00.000Z'));
      recalculateSubscriptions(db, '2026-06-26');

      const kicked = markSubscriptionUserKicked(db, 42, new Date('2026-06-27T00:00:00.000Z'));

      expect(kicked).toMatchObject({
        telegramUserId: 42,
        status: 'Kicked',
        removedFromGroup: true,
        kickedAt: '2026-06-27T00:00:00.000Z'
      });
      expect(startTrialIfEligible(db, { id: 42, username: 'late_user' }, new Date('2026-06-28T00:00:00.000Z')).started).toBe(false);
    } finally {
      db.close();
    }
  });

  it('does not overwrite a paid subscription when completing a stale kick', () => {
    const db = createDb();
    try {
      upsertSeenTelegramUser(db, { id: 42, username: 'late_user' }, new Date('2026-05-26T00:00:00.000Z'));
      applySubscriptionStartDate(db, 42, '2026-05-26', 1, new Date('2026-05-26T00:00:00.000Z'));
      recalculateSubscriptions(db, '2026-06-26');
      expect(isKickStillDue(db, 42, '2026-06-27', 1)).toBe(true);

      applySubscriptionStartDate(db, 42, '2026-06-27', 1, new Date('2026-06-27T00:30:00.000Z'));

      expect(
        markSubscriptionUserKickedIfStillDue(
          db,
          42,
          new Date('2026-06-27T01:00:00.000Z'),
          '2026-06-27',
          1
        )
      ).toBeUndefined();
      expect(getSubscriptionUser(db, 42)).toMatchObject({
        status: 'Subscribe',
        removedFromGroup: false,
        kickedAt: undefined
      });
    } finally {
      db.close();
    }
  });

  it('marks an overdue unpaid user kicked after the group removal race is observed', () => {
    const db = createDb();
    try {
      upsertSeenTelegramUser(db, { id: 42, username: 'late_user' }, new Date('2026-05-26T00:00:00.000Z'));
      applySubscriptionStartDate(db, 42, '2026-05-26', 1, new Date('2026-05-26T00:00:00.000Z'));
      recalculateSubscriptions(db, '2026-06-26');
      db.prepare('UPDATE subscription_users SET removed_from_group = 1 WHERE telegram_user_id = 42').run();

      expect(listKickCandidates(db, '2026-06-27', 1).map((user) => user.telegramUserId)).toEqual([]);
      expect(isKickStillDue(db, 42, '2026-06-27', 1)).toBe(true);
      expect(
        markSubscriptionUserKickedIfStillDue(
          db,
          42,
          new Date('2026-06-27T00:00:00.000Z'),
          '2026-06-27',
          1
        )
      ).toMatchObject({
        telegramUserId: 42,
        status: 'Kicked',
        removedFromGroup: true,
        kickedAt: '2026-06-27T00:00:00.000Z'
      });
    } finally {
      db.close();
    }
  });
});
