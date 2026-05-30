import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicSearchDatabase, type PublicSearchDatabase } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolvePublicSearchSchemaPath() {
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.resolve(process.cwd(), 'src/db/schema.sql')
  ];

  const schemaPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!schemaPath) {
    throw new Error(`Unable to find public search schema.sql. Checked: ${candidates.join(', ')}`);
  }

  return schemaPath;
}

export function migratePublicSearchDatabase(db: PublicSearchDatabase) {
  const schema = fs.readFileSync(resolvePublicSearchSchemaPath(), 'utf8');
  addSubscriptionJobsClaimedAtColumnIfNeeded(db);
  db.exec(schema);
  addSubscriptionUsersHistoryExportedAtColumnIfNeeded(db);
  addSubscriptionUsersTrialSearchesUsedColumnIfNeeded(db);
  addSubscriptionUsersPlanMonthsColumnIfNeeded(db);
  rebuildSubscriptionUsersConstraintsIfNeeded(db);
  rebuildSubscriptionJobsLeaseShapeIfNeeded(db);
  db.exec(schema);
}

function addSubscriptionJobsClaimedAtColumnIfNeeded(db: PublicSearchDatabase) {
  const row = db
    .prepare(
      `SELECT 1
       FROM sqlite_schema
       WHERE type = 'table'
         AND name = 'subscription_jobs'`
    )
    .get();

  if (!row) {
    return;
  }

  const columns = db.pragma('table_info(subscription_jobs)') as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'claimed_at')) {
    return;
  }

  db.exec('ALTER TABLE subscription_jobs ADD COLUMN claimed_at TEXT');
  db.prepare(
    `UPDATE subscription_jobs
     SET claimed_at = updated_at
     WHERE status = 'running'
       AND claimed_at IS NULL`
  ).run();
}

function addSubscriptionUsersHistoryExportedAtColumnIfNeeded(db: PublicSearchDatabase) {
  const row = db
    .prepare(
      `SELECT 1
       FROM sqlite_schema
       WHERE type = 'table'
         AND name = 'subscription_users'`
    )
    .get();

  if (!row) {
    return;
  }

  const columns = db.pragma('table_info(subscription_users)') as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'history_exported_at')) {
    return;
  }

  db.exec('ALTER TABLE subscription_users ADD COLUMN history_exported_at TEXT');
}

function addSubscriptionUsersTrialSearchesUsedColumnIfNeeded(db: PublicSearchDatabase) {
  const row = db
    .prepare(
      `SELECT 1
       FROM sqlite_schema
       WHERE type = 'table'
         AND name = 'subscription_users'`
    )
    .get();

  if (!row) {
    return;
  }

  const columns = db.pragma('table_info(subscription_users)') as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'trial_searches_used')) {
    return;
  }

  db.exec('ALTER TABLE subscription_users ADD COLUMN trial_searches_used INTEGER NOT NULL DEFAULT 0');
}

function addSubscriptionUsersPlanMonthsColumnIfNeeded(db: PublicSearchDatabase) {
  const row = db
    .prepare(
      `SELECT 1
       FROM sqlite_schema
       WHERE type = 'table'
         AND name = 'subscription_users'`
    )
    .get();

  if (!row) {
    return;
  }

  const columns = db.pragma('table_info(subscription_users)') as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'subscription_plan_months')) {
    return;
  }

  db.exec(
    'ALTER TABLE subscription_users ADD COLUMN subscription_plan_months INTEGER NOT NULL DEFAULT 1 CHECK (subscription_plan_months IN (1, 3, 6))'
  );
}

function rebuildSubscriptionUsersConstraintsIfNeeded(db: PublicSearchDatabase) {
  const row = db
    .prepare(
      `SELECT sql
       FROM sqlite_schema
       WHERE type = 'table'
         AND name = 'subscription_users'`
    )
    .get() as { sql: string } | undefined;

  const hasRemovedFromGroupConstraint = row?.sql.includes('CHECK (removed_from_group IN (0, 1))');
  const hasSubscriptionPlanMonthsConstraint = row?.sql.includes('CHECK (subscription_plan_months IN (1, 3, 6))');

  if (!row || (hasRemovedFromGroupConstraint && hasSubscriptionPlanMonthsConstraint)) {
    return;
  }

  const previousForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');

  try {
    db.exec(`
      DROP TABLE IF EXISTS subscription_users_new;

      CREATE TABLE subscription_users_new (
        telegram_user_id INTEGER PRIMARY KEY,
        username TEXT,
        trial_started_at TEXT,
        trial_expires_at TEXT,
        trial_searches_used INTEGER NOT NULL DEFAULT 0,
        subscription_start_date TEXT,
        subscription_end_date TEXT,
        subscription_plan_months INTEGER NOT NULL DEFAULT 1 CHECK (subscription_plan_months IN (1, 3, 6)),
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

      INSERT INTO subscription_users_new (
        telegram_user_id,
        username,
        trial_started_at,
        trial_expires_at,
        trial_searches_used,
        subscription_start_date,
        subscription_end_date,
        subscription_plan_months,
        days_remaining,
        status,
        unpaid_since,
        kicked_at,
        history_exported_at,
        removed_from_group,
        last_seen_at,
        created_at,
        updated_at
      )
      SELECT
        telegram_user_id,
        username,
        trial_started_at,
        trial_expires_at,
        COALESCE(trial_searches_used, 0),
        subscription_start_date,
        subscription_end_date,
        CASE WHEN subscription_plan_months IN (1, 3, 6) THEN subscription_plan_months ELSE 1 END,
        days_remaining,
        status,
        unpaid_since,
        kicked_at,
        history_exported_at,
        CASE WHEN removed_from_group = 1 THEN 1 ELSE 0 END,
        last_seen_at,
        created_at,
        updated_at
      FROM subscription_users;

      DROP TABLE subscription_users;
      ALTER TABLE subscription_users_new RENAME TO subscription_users;
    `);
  } finally {
    db.pragma(`foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
  }
}

function rebuildSubscriptionJobsLeaseShapeIfNeeded(db: PublicSearchDatabase) {
  const row = db
    .prepare(
      `SELECT sql
       FROM sqlite_schema
       WHERE type = 'table'
         AND name = 'subscription_jobs'`
    )
    .get() as { sql: string } | undefined;

  if (!row || (row.sql.includes('claimed_at') && row.sql.includes('json_valid(payload_json)'))) {
    return;
  }

  const columns = db.pragma('table_info(subscription_jobs)') as Array<{ name: string }>;
  const hasClaimedAt = columns.some((column) => column.name === 'claimed_at');
  const claimedAtSelect = hasClaimedAt
    ? 'claimed_at'
    : "CASE WHEN status = 'running' THEN updated_at ELSE NULL END AS claimed_at";
  const previousForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');

  try {
    db.exec(`
      DROP TABLE IF EXISTS subscription_jobs_new;

      CREATE TABLE subscription_jobs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK (type IN ('refresh-alert', 'kick-user', 'refresh-sheet')),
        payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        run_after TEXT NOT NULL,
        claimed_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO subscription_jobs_new (
        id,
        type,
        payload_json,
        status,
        attempts,
        run_after,
        claimed_at,
        last_error,
        created_at,
        updated_at
      )
      SELECT
        id,
        type,
        CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,
        status,
        attempts,
        run_after,
        ${claimedAtSelect},
        last_error,
        created_at,
        updated_at
      FROM subscription_jobs;

      DROP TABLE subscription_jobs;
      ALTER TABLE subscription_jobs_new RENAME TO subscription_jobs;
    `);
  } finally {
    db.pragma(`foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createPublicSearchDatabase(process.env.PUBLIC_SEARCH_DATABASE_PATH ?? './data/public-search.sqlite');
  migratePublicSearchDatabase(db);
  db.close();
  console.log('Public search database migrated');
}
