import type { PublicSearchDatabase } from '../db/database.js';
import { TelegramRateLimitError } from '../telegram.client.js';
import {
  claimNextSubscriptionJob,
  markSubscriptionJobFailed,
  markSubscriptionJobSucceeded,
  type SubscriptionJob
} from './job.repository.js';

export type SubscriptionJobHandlers = {
  refreshAlert: () => Promise<void>;
  refreshSheet: () => Promise<void>;
  kickUser: (telegramUserId: number) => Promise<void>;
};

export type ProcessSubscriptionJobOptions = {
  clock?: (() => Date) | undefined;
  maxAttempts?: number | undefined;
  staleAfterMs?: number | undefined;
};

export type ProcessSubscriptionJobResult =
  | { processed: false; failed: false }
  | { processed: true; failed: false; job: SubscriptionJob }
  | { processed: true; failed: true; job: SubscriptionJob; error: unknown };

const DEFAULT_MAX_ATTEMPTS = 5;

function retryAfterFor(error: unknown, attempts: number, now: Date) {
  if (error instanceof TelegramRateLimitError) {
    return new Date(now.getTime() + error.retryAfter * 1000);
  }

  const backoffSeconds = Math.min(300, Math.max(5, 5 * 2 ** attempts));
  return new Date(now.getTime() + backoffSeconds * 1000);
}

async function executeJob(job: SubscriptionJob, handlers: SubscriptionJobHandlers) {
  if (job.type === 'refresh-alert') {
    await handlers.refreshAlert();
    return;
  }

  if (job.type === 'refresh-sheet') {
    await handlers.refreshSheet();
    return;
  }

  const telegramUserId = job.payload.telegramUserId;
  if (typeof telegramUserId !== 'number') {
    throw new Error('kick-user job is missing numeric telegramUserId');
  }
  await handlers.kickUser(telegramUserId);
}

function requireClaimedAt(job: SubscriptionJob) {
  if (!job.claimedAt) {
    throw new Error(`Subscription job ${job.id} was claimed without a lease`);
  }

  return job.claimedAt;
}

export async function processNextSubscriptionJob(
  db: PublicSearchDatabase,
  handlers: SubscriptionJobHandlers,
  now: Date = new Date(),
  options: ProcessSubscriptionJobOptions = {}
): Promise<ProcessSubscriptionJobResult> {
  const job = claimNextSubscriptionJob(db, now, { staleAfterMs: options.staleAfterMs });
  if (!job) {
    return { processed: false, failed: false };
  }

  const claimedAt = requireClaimedAt(job);
  const clock = options.clock ?? (() => new Date());

  try {
    await executeJob(job, handlers);
    markSubscriptionJobSucceeded(db, job.id, claimedAt, clock());
  } catch (error) {
    const failedAt = clock();
    markSubscriptionJobFailed(db, job.id, claimedAt, error, retryAfterFor(error, job.attempts, failedAt), failedAt, {
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    });
    return { processed: true, failed: true, job, error };
  }

  return { processed: true, failed: false, job };
}
