import type { PublicSearchDatabase } from '../db/database.js';

export type SubscriptionJobType = 'refresh-alert' | 'kick-user' | 'refresh-sheet';
export type SubscriptionJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type SubscriptionJob = {
  id: number;
  type: SubscriptionJobType;
  payload: Record<string, unknown>;
  status: SubscriptionJobStatus;
  attempts: number;
  runAfter: string;
  claimedAt?: string | undefined;
  lastError?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

export type ClaimSubscriptionJobOptions = {
  staleAfterMs?: number | undefined;
};

export type MarkSubscriptionJobFailedOptions = {
  maxAttempts?: number | undefined;
};

export type SubscriptionJobHealth = {
  unhealthy: boolean;
  failedJobs: number;
  retryJobs: number;
  lastError?: string | undefined;
};

export type EnqueueSubscriptionJobIfNotActiveResult =
  | { enqueued: true; job: SubscriptionJob }
  | { enqueued: false; job: SubscriptionJob };

type SubscriptionJobRow = {
  id: number;
  type: SubscriptionJobType;
  payloadJson: string;
  status: SubscriptionJobStatus;
  attempts: number;
  runAfter: string;
  claimedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;

export function enqueueSubscriptionJob(
  db: PublicSearchDatabase,
  type: SubscriptionJobType,
  payload: Record<string, unknown>,
  runAfter: Date
): SubscriptionJob {
  const nowIso = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO subscription_jobs (
         type,
         payload_json,
         status,
         attempts,
         run_after,
         created_at,
         updated_at
       )
       VALUES (@type, @payloadJson, 'pending', 0, @runAfter, @nowIso, @nowIso)`
    )
    .run({
      type,
      payloadJson: JSON.stringify(payload),
      runAfter: runAfter.toISOString(),
      nowIso
    });

  return requireSubscriptionJob(db, Number(result.lastInsertRowid));
}

export function enqueueSubscriptionJobIfNotActive(
  db: PublicSearchDatabase,
  type: SubscriptionJobType,
  payload: Record<string, unknown>,
  runAfter: Date
): EnqueueSubscriptionJobIfNotActiveResult {
  const enqueue = db.transaction(() => {
    const active = db
      .prepare(
        `SELECT
           id,
           type,
           payload_json AS payloadJson,
           status,
           attempts,
           run_after AS runAfter,
           claimed_at AS claimedAt,
           last_error AS lastError,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM subscription_jobs
         WHERE type = @type
           AND status IN ('pending', 'running')
         ORDER BY run_after ASC, id ASC
         LIMIT 1`
      )
      .get({ type }) as SubscriptionJobRow | undefined;

    if (active) {
      return { enqueued: false as const, job: mapSubscriptionJob(active) };
    }

    return { enqueued: true as const, job: enqueueSubscriptionJob(db, type, payload, runAfter) };
  });

  return enqueue();
}

export function getSubscriptionJob(db: PublicSearchDatabase, id: number): SubscriptionJob | undefined {
  const row = db
    .prepare(
      `SELECT
         id,
         type,
         payload_json AS payloadJson,
         status,
         attempts,
         run_after AS runAfter,
         claimed_at AS claimedAt,
         last_error AS lastError,
         created_at AS createdAt,
         updated_at AS updatedAt
       FROM subscription_jobs
       WHERE id = ?`
    )
    .get(id) as SubscriptionJobRow | undefined;

  return row ? mapSubscriptionJob(row) : undefined;
}

export function listSubscriptionJobs(db: PublicSearchDatabase): SubscriptionJob[] {
  const rows = db
    .prepare(
      `SELECT
         id,
         type,
         payload_json AS payloadJson,
         status,
         attempts,
         run_after AS runAfter,
         claimed_at AS claimedAt,
         last_error AS lastError,
         created_at AS createdAt,
         updated_at AS updatedAt
       FROM subscription_jobs
       ORDER BY id ASC`
    )
    .all() as SubscriptionJobRow[];

  return rows.map(mapSubscriptionJob);
}

export function claimNextSubscriptionJob(
  db: PublicSearchDatabase,
  now: Date,
  options: ClaimSubscriptionJobOptions = {}
): SubscriptionJob | undefined {
  const nowIso = now.toISOString();
  const staleCutoff = new Date(now.getTime() - (options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)).toISOString();
  const claim = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT id, status
         FROM (
           SELECT
             id,
             status,
             run_after AS sort_at,
             0 AS priority
           FROM subscription_jobs
           WHERE status = 'pending'
             AND run_after <= @nowIso
           UNION ALL
           SELECT
             id,
             status,
             claimed_at AS sort_at,
             1 AS priority
           FROM subscription_jobs
           WHERE status = 'running'
             AND claimed_at IS NOT NULL
             AND claimed_at <= @staleCutoff
         )
         ORDER BY priority ASC, sort_at ASC, id ASC
         LIMIT 1`
      )
      .get({ nowIso, staleCutoff }) as { id: number; status: SubscriptionJobStatus } | undefined;

    if (!row) {
      return undefined;
    }

    const result = db
      .prepare(
        `UPDATE subscription_jobs
         SET status = 'running',
             claimed_at = @nowIso,
             updated_at = @nowIso
         WHERE id = @id
           AND (
             status = 'pending'
             OR (
               status = 'running'
               AND claimed_at IS NOT NULL
               AND claimed_at <= @staleCutoff
             )
           )`
      )
      .run({
        id: row.id,
        nowIso,
        staleCutoff
      });

    return result.changes === 1 ? getSubscriptionJob(db, row.id) : undefined;
  });

  return claim();
}

export function markSubscriptionJobSucceeded(
  db: PublicSearchDatabase,
  id: number,
  claimedAt: string,
  now: Date
): boolean {
  const result = db
    .prepare(
      `UPDATE subscription_jobs
       SET status = 'succeeded',
           claimed_at = NULL,
           last_error = NULL,
           updated_at = @nowIso
       WHERE id = @id
         AND status = 'running'
         AND claimed_at = @claimedAt`
    )
    .run({
      id,
      claimedAt,
      nowIso: now.toISOString()
    });

  return result.changes === 1;
}

export function markSubscriptionJobFailed(
  db: PublicSearchDatabase,
  id: number,
  claimedAt: string,
  error: unknown,
  runAfter: Date,
  now: Date,
  options: MarkSubscriptionJobFailedOptions = {}
): boolean {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const job = getSubscriptionJob(db, id);

  if (!job || job.status !== 'running' || job.claimedAt !== claimedAt) {
    return false;
  }

  const nextAttempts = job.attempts + 1;
  const terminal = nextAttempts >= maxAttempts;
  const result = db
    .prepare(
      `UPDATE subscription_jobs
       SET status = @status,
           attempts = @nextAttempts,
           run_after = @runAfter,
           claimed_at = NULL,
           last_error = @lastError,
           updated_at = @nowIso
       WHERE id = @id
         AND status = 'running'
         AND claimed_at = @claimedAt`
    )
    .run({
      id,
      claimedAt,
      status: terminal ? 'failed' : 'pending',
      nextAttempts,
      runAfter: runAfter.toISOString(),
      lastError: errorMessage(error),
      nowIso: now.toISOString()
    });

  return result.changes === 1;
}

export function getSubscriptionJobHealth(db: PublicSearchDatabase): SubscriptionJobHealth {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedJobs,
         SUM(CASE WHEN status = 'pending' AND last_error IS NOT NULL THEN 1 ELSE 0 END) AS retryJobs
       FROM subscription_jobs`
    )
    .get() as { failedJobs: number | null; retryJobs: number | null };
  const lastErrorRow = db
    .prepare(
      `SELECT last_error AS lastError
       FROM subscription_jobs
       WHERE last_error IS NOT NULL
         AND (
           status = 'failed'
           OR (status = 'pending' AND last_error IS NOT NULL)
         )
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`
    )
    .get() as { lastError: string | null } | undefined;
  const failedJobs = row.failedJobs ?? 0;
  const retryJobs = row.retryJobs ?? 0;

  return {
    unhealthy: failedJobs > 0 || retryJobs > 0,
    failedJobs,
    retryJobs,
    lastError: lastErrorRow?.lastError ?? undefined
  };
}

function requireSubscriptionJob(db: PublicSearchDatabase, id: number): SubscriptionJob {
  const job = getSubscriptionJob(db, id);

  if (!job) {
    throw new Error(`Subscription job not found: ${id}`);
  }

  return job;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  return parsed as Record<string, unknown>;
}

function mapSubscriptionJob(row: SubscriptionJobRow): SubscriptionJob {
  return {
    id: row.id,
    type: row.type,
    payload: parsePayload(row.payloadJson),
    status: row.status,
    attempts: row.attempts,
    runAfter: row.runAfter,
    claimedAt: row.claimedAt ?? undefined,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}
