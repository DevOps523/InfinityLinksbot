import { describe, expect, it, vi } from 'vitest';
import { createPublicSearchDatabase } from '../src/db/database.js';
import { migratePublicSearchDatabase } from '../src/db/migrate.js';
import { syncSubscriptionsFromSheet, moveKickedUsersToHistory } from '../src/subscriptions/sync.service.js';
import { HISTORY_HEADER, USERS_HEADER } from '../src/subscriptions/sheet.mapper.js';
import { getSubscriptionUser, isKickStillDue, markSubscriptionUserKicked } from '../src/subscriptions/repository.js';
import { createDailySubscriptionRefreshRun, runDailySubscriptionRefresh } from '../src/subscriptions/scheduler.js';

function createDb() {
  const db = createPublicSearchDatabase(':memory:');
  migratePublicSearchDatabase(db);
  return db;
}

describe('subscription sync service', () => {
  it('queues overdue kicks and refreshes alerts during daily refresh', async () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO subscription_users (
           telegram_user_id, username, subscription_start_date, subscription_end_date, days_remaining,
           status, unpaid_since, removed_from_group, created_at, updated_at
         )
         VALUES (42, 'late_user', '2026-05-26', '2026-06-26', 0, 'Unpaid', '2026-06-26', 0, '2026-05-26T00:00:00.000Z', '2026-06-26T00:00:00.000Z')`
      ).run();

      const result = await runDailySubscriptionRefresh(db, {
        today: '2026-06-27',
        overdueGraceDays: 1,
        enqueueAt: new Date('2026-06-27T00:00:00.000Z')
      });

      expect(result).toEqual({ queuedKicks: 1, skipped: false });
      expect(db.prepare('SELECT type, payload_json FROM subscription_jobs').all()).toEqual([
        { type: 'kick-user', payload_json: '{"telegramUserId":42}' },
        { type: 'refresh-alert', payload_json: '{}' },
        { type: 'refresh-sheet', payload_json: '{}' }
      ]);
    } finally {
      db.close();
    }
  });

  it('does not enqueue the same daily refresh batch twice', async () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO subscription_users (
           telegram_user_id, username, subscription_start_date, subscription_end_date, days_remaining,
           status, unpaid_since, removed_from_group, created_at, updated_at
         )
         VALUES (42, 'late_user', '2026-05-26', '2026-06-26', 0, 'Unpaid', '2026-06-26', 0, '2026-05-26T00:00:00.000Z', '2026-06-26T00:00:00.000Z')`
      ).run();

      await runDailySubscriptionRefresh(db, {
        today: '2026-06-27',
        overdueGraceDays: 1,
        enqueueAt: new Date('2026-06-27T00:00:00.000Z')
      });
      const duplicate = await runDailySubscriptionRefresh(db, {
        today: '2026-06-27',
        overdueGraceDays: 1,
        enqueueAt: new Date('2026-06-27T01:00:00.000Z')
      });

      expect(duplicate).toEqual({ queuedKicks: 0, skipped: true });
      expect(db.prepare('SELECT COUNT(*) AS count FROM subscription_jobs').get()).toEqual({ count: 3 });
    } finally {
      db.close();
    }
  });

  it('enqueues a new daily refresh batch on the next date', async () => {
    const db = createDb();
    try {
      await runDailySubscriptionRefresh(db, {
        today: '2026-06-27',
        overdueGraceDays: 1,
        enqueueAt: new Date('2026-06-27T00:00:00.000Z')
      });
      const nextDay = await runDailySubscriptionRefresh(db, {
        today: '2026-06-28',
        overdueGraceDays: 1,
        enqueueAt: new Date('2026-06-28T00:00:00.000Z')
      });

      expect(nextDay).toEqual({ queuedKicks: 0, skipped: false });
      expect(db.prepare('SELECT type, payload_json FROM subscription_jobs').all()).toEqual([
        { type: 'refresh-alert', payload_json: '{}' },
        { type: 'refresh-sheet', payload_json: '{}' },
        { type: 'refresh-alert', payload_json: '{}' },
        { type: 'refresh-sheet', payload_json: '{}' }
      ]);
    } finally {
      db.close();
    }
  });

  it('builds daily refresh runners without fixed period days', async () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO subscription_users (
           telegram_user_id, username, subscription_start_date, subscription_end_date, days_remaining,
           status, unpaid_since, removed_from_group, created_at, updated_at
         )
         VALUES (42, 'late_user', '2026-05-26', '2026-06-26', 0, 'Unpaid', '2026-06-26', 0, '2026-05-26T00:00:00.000Z', '2026-06-26T00:00:00.000Z')`
      ).run();

      const run = createDailySubscriptionRefreshRun({
        db,
        overdueGraceDays: 1,
        now: () => new Date('2026-06-27T00:00:00.000Z')
      });

      await expect(run()).resolves.toEqual({ queuedKicks: 1, skipped: false });
      expect(db.prepare('SELECT type, payload_json FROM subscription_jobs').all()).toEqual([
        { type: 'kick-user', payload_json: '{"telegramUserId":42}' },
        { type: 'refresh-alert', payload_json: '{}' },
        { type: 'refresh-sheet', payload_json: '{}' }
      ]);
    } finally {
      db.close();
    }
  });

  it('applies manual 3-month start dates and writes refreshed active rows', async () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO subscription_users (telegram_user_id, username, status, removed_from_group, created_at, updated_at)
         VALUES (42, 'paid_user', 'Unpaid', 0, '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z')`
      ).run();
      const sheets = {
        readRows: vi.fn(async () => [USERS_HEADER, ['42', '@paid_user', '2026-05-26', '3 Months', '', '', '', '']]),
        replaceRows: vi.fn(async () => undefined),
        appendRows: vi.fn(async () => undefined)
      };

      const result = await syncSubscriptionsFromSheet(db, sheets, {
        usersRange: 'Users!A:H',
        historyRange: 'History!A:G',
        now: new Date('2026-05-26T00:00:00.000Z')
      });

      expect(result).toEqual({
        updatedUsers: 1,
        skippedUnknownUsers: 0,
        paidUsers: []
      });
      expect(sheets.replaceRows).toHaveBeenCalledWith('Users!A:H', [
        USERS_HEADER,
        ['42', '@paid_user', '2026-05-26', '3 Months', '2026-08-26', '92', 'Subscribe', expect.any(String)]
      ]);
    } finally {
      db.close();
    }
  });

  it('updates an existing subscription when only the plan changes', async () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO subscription_users (
           telegram_user_id, username, subscription_start_date, subscription_end_date, days_remaining,
           status, removed_from_group, created_at, updated_at
         )
         VALUES (42, 'paid_user', '2026-05-26', '2026-06-26', 31, 'Subscribe', 0, '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z')`
      ).run();
      const sheets = {
        readRows: vi.fn(async () => [USERS_HEADER, ['42', '@paid_user', '2026-05-26', '3 Months', '', '', '', '']]),
        replaceRows: vi.fn(async () => undefined),
        appendRows: vi.fn(async () => undefined)
      };

      const result = await syncSubscriptionsFromSheet(db, sheets, {
        usersRange: 'Users!A:H',
        historyRange: 'History!A:G',
        now: new Date('2026-05-26T00:00:00.000Z')
      });

      expect(result).toEqual({
        updatedUsers: 1,
        skippedUnknownUsers: 0,
        paidUsers: []
      });
      expect(getSubscriptionUser(db, 42)).toEqual(
        expect.objectContaining({
          subscriptionStartDate: '2026-05-26',
          subscriptionPlanMonths: 3,
          subscriptionEndDate: '2026-08-26',
          daysRemaining: 92,
          status: 'Subscribe'
        })
      );
      expect(sheets.replaceRows).toHaveBeenCalledWith('Users!A:H', [
        USERS_HEADER,
        ['42', '@paid_user', '2026-05-26', '3 Months', '2026-08-26', '92', 'Subscribe', expect.any(String)]
      ]);
    } finally {
      db.close();
    }
  });

  it('defaults blank paid plan cells to one month and writes the canonical plan label', async () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO subscription_users (telegram_user_id, username, status, removed_from_group, created_at, updated_at)
         VALUES (42, 'paid_user', 'Unpaid', 0, '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z')`
      ).run();
      const sheets = {
        readRows: vi.fn(async () => [USERS_HEADER, ['42', '@paid_user', '2026-05-26', '', '', '', '', '']]),
        replaceRows: vi.fn(async () => undefined),
        appendRows: vi.fn(async () => undefined)
      };

      const result = await syncSubscriptionsFromSheet(db, sheets, {
        usersRange: 'Users!A:H',
        historyRange: 'History!A:G',
        now: new Date('2026-05-26T00:00:00.000Z')
      });

      expect(result.updatedUsers).toBe(1);
      expect(getSubscriptionUser(db, 42)).toEqual(
        expect.objectContaining({
          subscriptionPlanMonths: 1,
          subscriptionEndDate: '2026-06-26'
        })
      );
      expect(sheets.replaceRows).toHaveBeenCalledWith('Users!A:H', [
        USERS_HEADER,
        ['42', '@paid_user', '2026-05-26', '1 Month', '2026-06-26', '31', 'Subscribe', expect.any(String)]
      ]);
    } finally {
      db.close();
    }
  });

  it('skips unknown sheet ids instead of creating paid subscriptions', async () => {
    const db = createDb();
    try {
      const sheets = {
        readRows: vi.fn(async () => [USERS_HEADER, ['99', '@stranger', '2026-05-26', '1 Month', '', '', '', '']]),
        replaceRows: vi.fn(async () => undefined),
        appendRows: vi.fn(async () => undefined)
      };

      await expect(
        syncSubscriptionsFromSheet(db, sheets, {
          usersRange: 'Users!A:H',
          historyRange: 'History!A:G',
          now: new Date('2026-05-26T00:00:00.000Z')
        })
      ).resolves.toEqual({ updatedUsers: 0, skippedUnknownUsers: 1, paidUsers: [] });
      expect(sheets.replaceRows).toHaveBeenCalledWith('Users!A:H', [USERS_HEADER]);
    } finally {
      db.close();
    }
  });

  it('returns paid users when a kicked user receives a new start date', async () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO subscription_users (
           telegram_user_id, username, status, unpaid_since, removed_from_group, kicked_at, history_exported_at,
           created_at, updated_at
         )
         VALUES (42, 'returning_user', 'Kicked', '2026-06-27', 1, '2026-06-27T00:00:00.000Z', '2026-06-27T00:01:00.000Z',
           '2026-05-26T00:00:00.000Z', '2026-06-27T00:00:00.000Z')`
      ).run();
      const sheets = {
        readRows: vi.fn(async () => [USERS_HEADER, ['42', '@returning_user', '2026-06-28', '1 Month', '', '', '', '']]),
        replaceRows: vi.fn(async () => undefined),
        appendRows: vi.fn(async () => undefined)
      };

      const result = await syncSubscriptionsFromSheet(db, sheets, {
        usersRange: 'Users!A:H',
        historyRange: 'History!A:G',
        now: new Date('2026-06-28T00:00:00.000Z')
      });

      expect(result.updatedUsers).toBe(1);
      expect(result.paidUsers).toEqual([
        expect.objectContaining({
          telegramUserId: 42,
          status: 'Subscribe',
          removedFromGroup: true,
          kickedAt: '2026-06-27T00:00:00.000Z',
          historyExportedAt: '2026-06-27T00:01:00.000Z'
        })
      ]);
    } finally {
      db.close();
    }
  });

  it('exports pending kicked history before renewing a kicked user without an interim users rewrite', async () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO subscription_users (
           telegram_user_id, username, subscription_start_date, subscription_end_date, days_remaining,
           status, unpaid_since, removed_from_group, kicked_at, history_exported_at, created_at, updated_at
         )
         VALUES (
           42, 'returning_user', '2026-05-01', '2026-06-01', 0,
           'Kicked', '2026-06-01', 1, '2026-06-02T00:00:00.000Z', NULL,
           '2026-05-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z'
         )`
      ).run();
      const sheets = {
        readRows: vi.fn(async () => [USERS_HEADER, ['42', '@returning_user', '2026-06-28', '1 Month', '', '', '', '']]),
        replaceRows: vi.fn(async () => undefined),
        appendRows: vi.fn(async () => undefined)
      };

      const result = await syncSubscriptionsFromSheet(db, sheets, {
        usersRange: 'Users!A:H',
        historyRange: 'History!A:G',
        now: new Date('2026-06-28T00:00:00.000Z')
      });

      expect(result).toEqual({
        updatedUsers: 1,
        skippedUnknownUsers: 0,
        paidUsers: [
          expect.objectContaining({
            telegramUserId: 42,
            status: 'Subscribe',
            removedFromGroup: true,
            historyExportedAt: expect.any(String)
          })
        ]
      });
      expect(sheets.appendRows).toHaveBeenCalledWith('History!A:G', [
        ['42', '@returning_user', 'Kicked', '2026-06-02T00:00:00.000Z', '2026-05-01', '2026-06-01', 'Overdue subscription removed']
      ]);
      expect(sheets.replaceRows).toHaveBeenCalledTimes(1);
      expect(sheets.replaceRows).toHaveBeenCalledWith('Users!A:H', [
        USERS_HEADER,
        ['42', '@returning_user', '2026-06-28', '1 Month', '2026-07-28', '30', 'Subscribe', '2026-06-28T00:00:00.000Z']
      ]);
      expect(sheets.appendRows.mock.invocationCallOrder[0]).toBeLessThan(
        sheets.replaceRows.mock.invocationCallOrder[0] ?? 0
      );
    } finally {
      db.close();
    }
  });

  it('returns kicked active paid removed users again when the start date is already applied', async () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO subscription_users (
           telegram_user_id, username, subscription_start_date, subscription_end_date, days_remaining,
           status, removed_from_group, kicked_at, history_exported_at, created_at, updated_at
         )
         VALUES (
           42, 'returning_user', '2026-06-28', '2026-07-29', 31,
           'Kicked', 1, '2026-06-27T00:00:00.000Z', '2026-06-27T00:01:00.000Z',
           '2026-05-26T00:00:00.000Z', '2026-06-28T00:00:00.000Z'
         )`
      ).run();
      const sheets = {
        readRows: vi.fn(async () => [USERS_HEADER, ['42', '@returning_user', '2026-06-28', '1 Month', '', '', '', '']]),
        replaceRows: vi.fn(async () => undefined),
        appendRows: vi.fn(async () => undefined)
      };

      const result = await syncSubscriptionsFromSheet(db, sheets, {
        usersRange: 'Users!A:H',
        historyRange: 'History!A:G',
        now: new Date('2026-06-28T00:00:00.000Z')
      });

      expect(result).toEqual({
        updatedUsers: 0,
        skippedUnknownUsers: 0,
        paidUsers: [
          expect.objectContaining({
            telegramUserId: 42,
            status: 'Subscribe',
            removedFromGroup: true
          })
        ]
      });
      expect(getSubscriptionUser(db, 42)).toEqual(
        expect.objectContaining({
          status: 'Subscribe',
          removedFromGroup: true,
          kickedAt: '2026-06-27T00:00:00.000Z',
          historyExportedAt: '2026-06-27T00:01:00.000Z'
        })
      );
    } finally {
      db.close();
    }
  });

  it('does not return paid users when a kicked user receives an old unpaid start date', async () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO subscription_users (
           telegram_user_id, username, status, unpaid_since, removed_from_group, kicked_at, history_exported_at,
           created_at, updated_at
         )
         VALUES (42, 'returning_user', 'Kicked', '2026-06-27', 1, '2026-06-27T00:00:00.000Z', '2026-06-27T00:01:00.000Z',
           '2026-05-26T00:00:00.000Z', '2026-06-27T00:00:00.000Z')`
      ).run();
      const sheets = {
        readRows: vi.fn(async () => [USERS_HEADER, ['42', '@returning_user', '2026-05-01', '1 Month', '', '', '', '']]),
        replaceRows: vi.fn(async () => undefined),
        appendRows: vi.fn(async () => undefined)
      };

      const result = await syncSubscriptionsFromSheet(db, sheets, {
        usersRange: 'Users!A:H',
        historyRange: 'History!A:G',
        now: new Date('2026-06-28T00:00:00.000Z')
      });

      expect(result).toEqual({ updatedUsers: 1, skippedUnknownUsers: 0, paidUsers: [] });
      expect(getSubscriptionUser(db, 42)).toEqual(
        expect.objectContaining({
          subscriptionStartDate: '2026-05-01',
          subscriptionEndDate: '2026-06-01',
          daysRemaining: 0,
          status: 'Kicked',
          unpaidSince: '2026-06-27',
          removedFromGroup: true,
          kickedAt: '2026-06-27T00:00:00.000Z',
          historyExportedAt: '2026-06-27T00:01:00.000Z'
        })
      );
      expect(sheets.replaceRows).toHaveBeenCalledWith('Users!A:H', [USERS_HEADER]);
    } finally {
      db.close();
    }
  });

  it('exports pending history for an already kicked user on kick retry', async () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO subscription_users (
           telegram_user_id, username, subscription_start_date, subscription_end_date, days_remaining,
           status, unpaid_since, removed_from_group, kicked_at, history_exported_at, created_at, updated_at
         )
         VALUES (
           42, 'late_user', '2026-05-01', '2026-06-01', 0,
           'Kicked', '2026-06-01', 1, '2026-06-02T00:00:00.000Z', NULL,
           '2026-05-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z'
         )`
      ).run();
      const sheets = {
        replaceRows: vi.fn(async () => undefined),
        appendRows: vi.fn(async () => undefined)
      };

      const alreadyKickedUser = getSubscriptionUser(db, 42);
      expect(isKickStillDue(db, 42, '2026-06-03', 1)).toBe(false);
      expect(alreadyKickedUser).toEqual(
        expect.objectContaining({
          status: 'Kicked',
          historyExportedAt: undefined
        })
      );

      await expect(
        moveKickedUsersToHistory(db, sheets, {
          usersRange: 'Users!A:H',
          historyRange: 'History!A:G',
          users: alreadyKickedUser ? [alreadyKickedUser] : []
        })
      ).resolves.toEqual({ movedUsers: 1 });

      expect(sheets.appendRows).toHaveBeenCalledWith('History!A:G', [
        ['42', '@late_user', 'Kicked', '2026-06-02T00:00:00.000Z', '2026-05-01', '2026-06-01', 'Overdue subscription removed']
      ]);
      expect(getSubscriptionUser(db, 42)?.historyExportedAt).toEqual(expect.any(String));
      expect(sheets.replaceRows).toHaveBeenCalledWith('Users!A:H', [USERS_HEADER]);
    } finally {
      db.close();
    }
  });

  it('moves kicked users to history and refreshes active rows', async () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO subscription_users (
           telegram_user_id, username, subscription_start_date, subscription_end_date, days_remaining,
           status, removed_from_group, created_at, updated_at
         )
         VALUES
           (42, 'late_user', '2026-05-01', '2026-06-01', 0, 'Unpaid', 0, '2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
           (43, 'active_user', '2026-05-26', '2026-06-26', 31, 'Subscribe', 0, '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z')`
      ).run();
      const kicked = markSubscriptionUserKicked(db, 42, new Date('2026-06-02T00:00:00.000Z'));
      const sheets = {
        replaceRows: vi.fn(async () => undefined),
        appendRows: vi.fn(async () => undefined)
      };

      await expect(
        moveKickedUsersToHistory(db, sheets, {
          usersRange: 'Users!A:H',
          historyRange: 'History!A:G',
          users: [kicked]
        })
      ).resolves.toEqual({ movedUsers: 1 });

      expect(HISTORY_HEADER).toEqual(['User ID', 'Username', 'Last Status', 'Kicked At', 'Last Start Date', 'Last End Date', 'Notes']);
      expect(sheets.appendRows).toHaveBeenCalledWith('History!A:G', [
        ['42', '@late_user', 'Kicked', '2026-06-02T00:00:00.000Z', '2026-05-01', '2026-06-01', 'Overdue subscription removed']
      ]);
      expect(sheets.replaceRows).toHaveBeenCalledWith('Users!A:H', [
        USERS_HEADER,
        ['43', '@active_user', '2026-05-26', '1 Month', '2026-06-26', '31', 'Subscribe', '2026-05-26T00:00:00.000Z']
      ]);
    } finally {
      db.close();
    }
  });

  it('does not duplicate history rows when retrying after active row refresh fails', async () => {
    const db = createDb();
    try {
      db.prepare(
        `INSERT INTO subscription_users (
           telegram_user_id, username, subscription_start_date, subscription_end_date, days_remaining,
           status, removed_from_group, created_at, updated_at
         )
         VALUES
           (42, 'late_user', '2026-05-01', '2026-06-01', 0, 'Unpaid', 0, '2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
           (43, 'active_user', '2026-05-26', '2026-06-26', 31, 'Subscribe', 0, '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z')`
      ).run();
      const kicked = markSubscriptionUserKicked(db, 42, new Date('2026-06-02T00:00:00.000Z'));
      const sheets = {
        replaceRows: vi
          .fn()
          .mockRejectedValueOnce(new Error('Users sheet unavailable'))
          .mockResolvedValueOnce(undefined),
        appendRows: vi.fn(async () => undefined)
      };

      await expect(
        moveKickedUsersToHistory(db, sheets, {
          usersRange: 'Users!A:H',
          historyRange: 'History!A:G',
          users: [kicked]
        })
      ).rejects.toThrow(/Users sheet unavailable/);

      expect(sheets.appendRows).toHaveBeenCalledTimes(1);
      expect(getSubscriptionUser(db, 42)?.historyExportedAt).toEqual(expect.any(String));

      await expect(
        moveKickedUsersToHistory(db, sheets, {
          usersRange: 'Users!A:H',
          historyRange: 'History!A:G',
          users: [kicked]
        })
      ).resolves.toEqual({ movedUsers: 0 });

      expect(sheets.appendRows).toHaveBeenCalledTimes(1);
      expect(sheets.replaceRows).toHaveBeenCalledTimes(2);
      expect(sheets.replaceRows).toHaveBeenLastCalledWith('Users!A:H', [
        USERS_HEADER,
        ['43', '@active_user', '2026-05-26', '1 Month', '2026-06-26', '31', 'Subscribe', '2026-05-26T00:00:00.000Z']
      ]);
    } finally {
      db.close();
    }
  });
});
