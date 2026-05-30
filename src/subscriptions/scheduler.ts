import type { PublicSearchDatabase } from '../db/database.js';
import { todayDateString } from './date.js';
import { enqueueSubscriptionJob } from './job.repository.js';
import { listKickCandidates, recalculateSubscriptions } from './repository.js';

export type DailySubscriptionRefreshOptions = {
  today: string;
  overdueGraceDays: number;
  enqueueAt: Date;
};

export type DailySubscriptionRefreshResult = {
  queuedKicks: number;
  skipped: boolean;
};

export type StartDailySubscriptionRefreshLoopOptions = {
  run: () => Promise<void>;
  intervalMs?: number | undefined;
};

export async function runDailySubscriptionRefresh(
  db: PublicSearchDatabase,
  options: DailySubscriptionRefreshOptions
): Promise<DailySubscriptionRefreshResult> {
  const refresh = db.transaction(() => {
    if (!claimDailyRefreshDate(db, options.today, options.enqueueAt)) {
      return { queuedKicks: 0, skipped: true };
    }

    recalculateSubscriptions(db, options.today);
    const kickCandidates = listKickCandidates(db, options.today, options.overdueGraceDays);

    for (const user of kickCandidates) {
      enqueueSubscriptionJob(db, 'kick-user', { telegramUserId: user.telegramUserId }, options.enqueueAt);
    }
    enqueueSubscriptionJob(db, 'refresh-alert', {}, options.enqueueAt);
    enqueueSubscriptionJob(db, 'refresh-sheet', {}, options.enqueueAt);

    return { queuedKicks: kickCandidates.length, skipped: false };
  });

  return refresh();
}

export function startDailySubscriptionRefreshLoop(input: StartDailySubscriptionRefreshLoopOptions) {
  const intervalMs = input.intervalMs ?? 60 * 60 * 1000;
  void input.run();

  return setInterval(() => {
    void input.run();
  }, intervalMs);
}

export function createDailySubscriptionRefreshRun(input: {
  db: PublicSearchDatabase;
  overdueGraceDays: number;
  now?: (() => Date) | undefined;
}) {
  const now = input.now ?? (() => new Date());

  return () => {
    const enqueueAt = now();
    return runDailySubscriptionRefresh(input.db, {
      today: todayDateString(enqueueAt),
      overdueGraceDays: input.overdueGraceDays,
      enqueueAt
    });
  };
}

function claimDailyRefreshDate(db: PublicSearchDatabase, today: string, enqueueAt: Date) {
  const row = db
    .prepare('SELECT last_refresh_date AS lastRefreshDate FROM subscription_daily_refresh_state WHERE id = 1')
    .get() as { lastRefreshDate: string | null } | undefined;

  if (row?.lastRefreshDate === today) {
    return false;
  }

  db.prepare(
    `INSERT INTO subscription_daily_refresh_state (id, last_refresh_date, updated_at)
     VALUES (1, @today, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       last_refresh_date = excluded.last_refresh_date,
       updated_at = excluded.updated_at`
  ).run({
    today,
    updatedAt: enqueueAt.toISOString()
  });

  return true;
}
