import { describe, expect, it, vi } from 'vitest';
import { TelegramRateLimitError } from '../src/telegram.client.js';
import { createPublicSearchDatabase } from '../src/db/database.js';
import { migratePublicSearchDatabase } from '../src/db/migrate.js';
import {
  enqueueSubscriptionJob,
  enqueueSubscriptionJobIfNotActive,
  getSubscriptionJobHealth,
  listSubscriptionJobs,
  claimNextSubscriptionJob,
  markSubscriptionJobSucceeded,
  markSubscriptionJobFailed
} from '../src/subscriptions/job.repository.js';
import { processNextSubscriptionJob } from '../src/subscriptions/job.processor.js';

function createDb() {
  const db = createPublicSearchDatabase(':memory:');
  migratePublicSearchDatabase(db);
  return db;
}

describe('subscription jobs', () => {
  it('deduplicates active refresh-sheet jobs', () => {
    const db = createDb();
    try {
      const first = enqueueSubscriptionJobIfNotActive(
        db,
        'refresh-sheet',
        {},
        new Date('2026-05-26T00:05:00.000Z')
      );
      const duplicate = enqueueSubscriptionJobIfNotActive(
        db,
        'refresh-sheet',
        {},
        new Date('2026-05-26T00:06:00.000Z')
      );

      expect(first.enqueued).toBe(true);
      expect(duplicate).toEqual({ enqueued: false, job: first.job });
      expect(listSubscriptionJobs(db)).toHaveLength(1);
      expect(listSubscriptionJobs(db)[0]).toMatchObject({
        type: 'refresh-sheet',
        status: 'pending',
        runAfter: '2026-05-26T00:05:00.000Z'
      });
    } finally {
      db.close();
    }
  });

  it('allows a new refresh-sheet job after prior active jobs finish', () => {
    const db = createDb();
    try {
      const first = enqueueSubscriptionJobIfNotActive(
        db,
        'refresh-sheet',
        {},
        new Date('2026-05-26T00:05:00.000Z')
      );
      const claimed = claimNextSubscriptionJob(db, new Date('2026-05-26T00:05:00.000Z'));
      expect(
        markSubscriptionJobSucceeded(db, first.job.id, claimed?.claimedAt ?? '', new Date('2026-05-26T00:05:01.000Z'))
      ).toBe(true);

      const second = enqueueSubscriptionJobIfNotActive(
        db,
        'refresh-sheet',
        {},
        new Date('2026-05-26T00:10:00.000Z')
      );

      expect(second.enqueued).toBe(true);
      expect(listSubscriptionJobs(db)).toHaveLength(2);
      expect(listSubscriptionJobs(db)[1]).toMatchObject({
        type: 'refresh-sheet',
        status: 'pending',
        runAfter: '2026-05-26T00:10:00.000Z'
      });
    } finally {
      db.close();
    }
  });

  it('claims due jobs and records success', () => {
    const db = createDb();
    try {
      const job = enqueueSubscriptionJob(db, 'refresh-alert', {}, new Date('2026-05-26T00:00:00.000Z'));
      const claimed = claimNextSubscriptionJob(db, new Date('2026-05-26T00:00:01.000Z'));
      expect(claimed).toMatchObject({
        id: job.id,
        type: 'refresh-alert',
        status: 'running',
        claimedAt: '2026-05-26T00:00:01.000Z'
      });

      expect(markSubscriptionJobSucceeded(db, job.id, claimed?.claimedAt ?? '', new Date('2026-05-26T00:00:02.000Z'))).toBe(true);
      expect(listSubscriptionJobs(db)).toEqual([
        expect.objectContaining({ id: job.id, status: 'succeeded', claimedAt: undefined })
      ]);
    } finally {
      db.close();
    }
  });

  it('does not claim jobs before run_after', () => {
    const db = createDb();
    try {
      enqueueSubscriptionJob(db, 'refresh-alert', {}, new Date('2026-05-26T00:01:00.000Z'));

      expect(claimNextSubscriptionJob(db, new Date('2026-05-26T00:00:59.000Z'))).toBeUndefined();
      expect(claimNextSubscriptionJob(db, new Date('2026-05-26T00:01:00.000Z'))).toMatchObject({
        status: 'running'
      });
    } finally {
      db.close();
    }
  });

  it('claims due jobs by run_after then id', () => {
    const db = createDb();
    try {
      const second = enqueueSubscriptionJob(db, 'refresh-alert', {}, new Date('2026-05-26T00:00:02.000Z'));
      const first = enqueueSubscriptionJob(db, 'refresh-sheet', {}, new Date('2026-05-26T00:00:01.000Z'));
      const third = enqueueSubscriptionJob(db, 'kick-user', { telegramUserId: 42 }, new Date('2026-05-26T00:00:02.000Z'));

      expect(claimNextSubscriptionJob(db, new Date('2026-05-26T00:00:03.000Z'))?.id).toBe(first.id);
      expect(claimNextSubscriptionJob(db, new Date('2026-05-26T00:00:04.000Z'))?.id).toBe(second.id);
      expect(claimNextSubscriptionJob(db, new Date('2026-05-26T00:00:05.000Z'))?.id).toBe(third.id);
    } finally {
      db.close();
    }
  });

  it('reclaims running jobs only after the stale timeout', () => {
    const db = createDb();
    try {
      const job = enqueueSubscriptionJob(db, 'refresh-alert', {}, new Date('2026-05-26T00:00:00.000Z'));

      expect(claimNextSubscriptionJob(db, new Date('2026-05-26T00:00:01.000Z'))?.id).toBe(job.id);
      expect(
        claimNextSubscriptionJob(db, new Date('2026-05-26T00:05:00.000Z'), { staleAfterMs: 10 * 60 * 1000 })
      ).toBeUndefined();
      expect(
        claimNextSubscriptionJob(db, new Date('2026-05-26T00:11:02.000Z'), { staleAfterMs: 10 * 60 * 1000 })
      ).toMatchObject({
        id: job.id,
        status: 'running',
        claimedAt: '2026-05-26T00:11:02.000Z'
      });
    } finally {
      db.close();
    }
  });

  it('makes legacy migrated running jobs reclaimable', () => {
    const db = createPublicSearchDatabase(':memory:');
    try {
      db.exec(`
        CREATE TABLE subscription_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK (type IN ('refresh-alert', 'kick-user', 'refresh-sheet')),
          payload_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          run_after TEXT NOT NULL,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO subscription_jobs (
          type,
          payload_json,
          status,
          attempts,
          run_after,
          created_at,
          updated_at
        )
        VALUES (
          'refresh-alert',
          '{}',
          'running',
          0,
          '2026-05-26T00:00:00.000Z',
          '2026-05-26T00:00:00.000Z',
          '2026-05-26T00:00:01.000Z'
        );
      `);

      migratePublicSearchDatabase(db);

      expect(listSubscriptionJobs(db)[0]).toMatchObject({
        status: 'running',
        claimedAt: '2026-05-26T00:00:01.000Z'
      });
      expect(
        claimNextSubscriptionJob(db, new Date('2026-05-26T00:11:02.000Z'), { staleAfterMs: 10 * 60 * 1000 })
      ).toMatchObject({
        status: 'running',
        claimedAt: '2026-05-26T00:11:02.000Z'
      });
    } finally {
      db.close();
    }
  });

  it('does not let success or failure helpers overwrite non-running jobs', () => {
    const db = createDb();
    try {
      const pending = enqueueSubscriptionJob(db, 'refresh-alert', {}, new Date('2026-05-26T00:00:00.000Z'));

      expect(markSubscriptionJobSucceeded(db, pending.id, 'stale-lease', new Date('2026-05-26T00:00:01.000Z'))).toBe(false);
      expect(
        markSubscriptionJobFailed(
          db,
          pending.id,
          'stale-lease',
          new Error('ignored'),
          new Date('2026-05-26T00:00:06.000Z'),
          new Date('2026-05-26T00:00:01.000Z')
        )
      ).toBe(false);
      expect(listSubscriptionJobs(db)[0]).toMatchObject({
        id: pending.id,
        status: 'pending',
        attempts: 0,
        runAfter: '2026-05-26T00:00:00.000Z',
        lastError: undefined
      });
    } finally {
      db.close();
    }
  });

  it('guards completion and failure by the claimed lease', () => {
    const db = createDb();
    try {
      const job = enqueueSubscriptionJob(db, 'refresh-alert', {}, new Date('2026-05-26T00:00:00.000Z'));
      const workerA = claimNextSubscriptionJob(db, new Date('2026-05-26T00:00:01.000Z'));
      const workerALease = workerA?.claimedAt ?? '';
      expect(workerA).toMatchObject({
        id: job.id,
        status: 'running',
        claimedAt: '2026-05-26T00:00:01.000Z'
      });

      const workerB = claimNextSubscriptionJob(db, new Date('2026-05-26T00:11:02.000Z'), {
        staleAfterMs: 10 * 60 * 1000
      });
      const workerBLease = workerB?.claimedAt ?? '';
      expect(workerB).toMatchObject({
        id: job.id,
        status: 'running',
        claimedAt: '2026-05-26T00:11:02.000Z'
      });

      expect(markSubscriptionJobSucceeded(db, job.id, workerALease, new Date('2026-05-26T00:11:03.000Z'))).toBe(false);
      expect(listSubscriptionJobs(db)[0]).toMatchObject({
        id: job.id,
        status: 'running',
        claimedAt: workerBLease
      });

      expect(
        markSubscriptionJobFailed(
          db,
          job.id,
          workerALease,
          new Error('stale failure'),
          new Date('2026-05-26T00:11:08.000Z'),
          new Date('2026-05-26T00:11:03.000Z')
        )
      ).toBe(false);
      expect(listSubscriptionJobs(db)[0]).toMatchObject({
        id: job.id,
        status: 'running',
        claimedAt: workerBLease,
        lastError: undefined
      });

      expect(markSubscriptionJobSucceeded(db, job.id, workerBLease, new Date('2026-05-26T00:11:04.000Z'))).toBe(true);
      expect(listSubscriptionJobs(db)[0]).toMatchObject({
        id: job.id,
        status: 'succeeded',
        claimedAt: undefined
      });
    } finally {
      db.close();
    }
  });

  it('backs off rate limited jobs using retry_after', async () => {
    const db = createDb();
    try {
      enqueueSubscriptionJob(db, 'kick-user', { telegramUserId: 42 }, new Date('2026-05-26T00:00:00.000Z'));
      const handlers = {
        kickUser: vi.fn(async () => {
          throw new TelegramRateLimitError('Too Many Requests', 12);
        }),
        refreshAlert: vi.fn(),
        refreshSheet: vi.fn()
      };

      await expect(
        processNextSubscriptionJob(db, handlers, new Date('2026-05-26T00:00:01.000Z'), {
          clock: () => new Date('2026-05-26T00:00:01.000Z')
        })
      ).resolves.toMatchObject({ processed: true, failed: true });

      expect(listSubscriptionJobs(db)[0]).toMatchObject({
        status: 'pending',
        attempts: 1,
        runAfter: '2026-05-26T00:00:13.000Z',
        lastError: 'Too Many Requests',
        claimedAt: undefined
      });
    } finally {
      db.close();
    }
  });

  it('reports successful and empty job processor results', async () => {
    const db = createDb();
    try {
      enqueueSubscriptionJob(db, 'refresh-alert', {}, new Date('2026-05-26T00:00:00.000Z'));
      const handlers = {
        kickUser: vi.fn(),
        refreshAlert: vi.fn(async () => undefined),
        refreshSheet: vi.fn()
      };

      await expect(
        processNextSubscriptionJob(db, handlers, new Date('2026-05-26T00:00:01.000Z'), {
          clock: () => new Date('2026-05-26T00:00:02.000Z')
        })
      ).resolves.toMatchObject({ processed: true, failed: false });
      await expect(processNextSubscriptionJob(db, handlers, new Date('2026-05-26T00:00:03.000Z'))).resolves.toEqual({
        processed: false,
        failed: false
      });
    } finally {
      db.close();
    }
  });

  it('returns the handler error when a job is retried', async () => {
    const db = createDb();
    try {
      enqueueSubscriptionJob(db, 'refresh-sheet', {}, new Date('2026-05-26T00:00:00.000Z'));
      const error = new Error('sheet unavailable');
      const handlers = {
        kickUser: vi.fn(),
        refreshAlert: vi.fn(),
        refreshSheet: vi.fn(async () => {
          throw error;
        })
      };

      await expect(
        processNextSubscriptionJob(db, handlers, new Date('2026-05-26T00:00:01.000Z'), {
          clock: () => new Date('2026-05-26T00:00:01.000Z')
        })
      ).resolves.toMatchObject({ processed: true, failed: true, error });
      expect(getSubscriptionJobHealth(db)).toEqual({
        unhealthy: true,
        failedJobs: 0,
        retryJobs: 1,
        lastError: 'sheet unavailable'
      });
    } finally {
      db.close();
    }
  });

  it('backs off generic failures for 5 seconds on the first attempt', async () => {
    const db = createDb();
    try {
      enqueueSubscriptionJob(db, 'refresh-alert', {}, new Date('2026-05-26T00:00:00.000Z'));
      const handlers = {
        kickUser: vi.fn(),
        refreshAlert: vi.fn(async () => {
          throw new Error('temporary failure');
        }),
        refreshSheet: vi.fn()
      };

      await expect(
        processNextSubscriptionJob(db, handlers, new Date('2026-05-26T00:00:01.000Z'), {
          clock: () => new Date('2026-05-26T00:00:01.000Z')
        })
      ).resolves.toMatchObject({ processed: true, failed: true });

      expect(listSubscriptionJobs(db)[0]).toMatchObject({
        status: 'pending',
        attempts: 1,
        runAfter: '2026-05-26T00:00:06.000Z',
        lastError: 'temporary failure'
      });
    } finally {
      db.close();
    }
  });

  it('schedules generic retries from failure time instead of claim time', async () => {
    const db = createDb();
    try {
      enqueueSubscriptionJob(db, 'refresh-alert', {}, new Date('2026-05-26T00:00:00.000Z'));
      const handlers = {
        kickUser: vi.fn(),
        refreshAlert: vi.fn(async () => {
          throw new Error('slow failure');
        }),
        refreshSheet: vi.fn()
      };

      await expect(
        processNextSubscriptionJob(db, handlers, new Date('2026-05-26T00:00:00.000Z'), {
          clock: () => new Date('2026-05-26T00:01:00.000Z')
        })
      ).resolves.toMatchObject({ processed: true, failed: true });

      expect(listSubscriptionJobs(db)[0]).toMatchObject({
        status: 'pending',
        attempts: 1,
        runAfter: '2026-05-26T00:01:05.000Z',
        lastError: 'slow failure'
      });
    } finally {
      db.close();
    }
  });

  it('marks permanently invalid kick-user payloads failed at max attempts', async () => {
    const db = createDb();
    try {
      enqueueSubscriptionJob(db, 'kick-user', {}, new Date('2026-05-26T00:00:00.000Z'));
      const handlers = {
        kickUser: vi.fn(),
        refreshAlert: vi.fn(),
        refreshSheet: vi.fn()
      };

      await expect(
        processNextSubscriptionJob(db, handlers, new Date('2026-05-26T00:00:01.000Z'), {
          clock: () => new Date('2026-05-26T00:00:01.000Z'),
          maxAttempts: 1
        })
      ).resolves.toMatchObject({ processed: true, failed: true });

      expect(handlers.kickUser).not.toHaveBeenCalled();
      expect(listSubscriptionJobs(db)[0]).toMatchObject({
        status: 'failed',
        attempts: 1,
        lastError: 'kick-user job is missing numeric telegramUserId',
        claimedAt: undefined
      });
      expect(getSubscriptionJobHealth(db)).toEqual({
        unhealthy: true,
        failedJobs: 1,
        retryJobs: 0,
        lastError: 'kick-user job is missing numeric telegramUserId'
      });
    } finally {
      db.close();
    }
  });

  it('reports healthy when no failed or retrying jobs remain', async () => {
    const db = createDb();
    try {
      enqueueSubscriptionJob(db, 'refresh-alert', {}, new Date('2026-05-26T00:00:00.000Z'));
      const handlers = {
        kickUser: vi.fn(),
        refreshAlert: vi.fn(async () => undefined),
        refreshSheet: vi.fn()
      };

      await processNextSubscriptionJob(db, handlers, new Date('2026-05-26T00:00:01.000Z'), {
        clock: () => new Date('2026-05-26T00:00:02.000Z')
      });

      expect(getSubscriptionJobHealth(db)).toEqual({
        unhealthy: false,
        failedJobs: 0,
        retryJobs: 0,
        lastError: undefined
      });
    } finally {
      db.close();
    }
  });

  it('rejects invalid payload_json through the schema constraint', () => {
    const db = createDb();
    try {
      expect(() => {
        db.prepare(
          `INSERT INTO subscription_jobs (
             type,
             payload_json,
             run_after,
             created_at,
             updated_at
           )
           VALUES ('refresh-alert', '{bad json', '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z')`
        ).run();
      }).toThrow();
    } finally {
      db.close();
    }
  });
});
