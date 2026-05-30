import { describe, expect, it } from 'vitest';
import { createPublicSearchDatabase } from '../src/db/database.js';
import { migratePublicSearchDatabase } from '../src/db/migrate.js';

function createMigratedDatabase() {
  const db = createPublicSearchDatabase(':memory:');
  migratePublicSearchDatabase(db);
  return db;
}

function tableNames(db: ReturnType<typeof createPublicSearchDatabase>) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function columnNames(db: ReturnType<typeof createPublicSearchDatabase>, tableName: string) {
  return (db.pragma(`table_info(${tableName})`) as Array<{ name: string }>).map((column) => column.name);
}

function tableSql(db: ReturnType<typeof createPublicSearchDatabase>, tableName: string) {
  return (
    db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName) as
      | { sql: string }
      | undefined
  )?.sql;
}

describe('public search database', () => {
  it('creates the public search service tables', () => {
    const db = createMigratedDatabase();

    try {
      expect(tableNames(db)).toEqual([
        'public_episode_providers',
        'public_episodes',
        'public_movie_providers',
        'public_movies',
        'public_seasons',
        'public_sync_state',
        'public_tv_shows',
        'subscription_alert_state',
        'subscription_daily_refresh_state',
        'subscription_jobs',
        'subscription_users'
      ]);
    } finally {
      db.close();
    }
  });

  it('creates trial search quota state on subscription users', () => {
    const db = createMigratedDatabase();

    try {
      expect(columnNames(db, 'subscription_users')).toContain('trial_searches_used');
      const row = db
        .prepare(
          `INSERT INTO subscription_users (
             telegram_user_id,
             status,
             removed_from_group,
             created_at,
             updated_at
           )
           VALUES (42, 'Unpaid', 0, '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z')
           RETURNING trial_searches_used AS trialSearchesUsed`
        )
        .get() as { trialSearchesUsed: number };

      expect(row.trialSearchesUsed).toBe(0);
    } finally {
      db.close();
    }
  });

  it('creates subscription plan months with a one-month default', () => {
    const db = createMigratedDatabase();

    try {
      expect(columnNames(db, 'subscription_users')).toContain('subscription_plan_months');
      const row = db
        .prepare(
          `INSERT INTO subscription_users (
             telegram_user_id,
             status,
             removed_from_group,
             created_at,
             updated_at
           )
           VALUES (42, 'Unpaid', 0, '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z')
           RETURNING subscription_plan_months AS subscriptionPlanMonths`
        )
        .get() as { subscriptionPlanMonths: number };

      expect(row.subscriptionPlanMonths).toBe(1);
      expect(tableSql(db, 'subscription_users')).toContain('CHECK (subscription_plan_months IN (1, 3, 6))');
      expect(() =>
        db
          .prepare(
            `INSERT INTO subscription_users (
               telegram_user_id,
               subscription_plan_months,
               status,
               removed_from_group,
               created_at,
               updated_at
             )
             VALUES (43, 2, 'Unpaid', 0, '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z')`
          )
          .run()
      ).toThrow();
      expect(() =>
        db.prepare('UPDATE subscription_users SET subscription_plan_months = 2 WHERE telegram_user_id = 42').run()
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('adds subscription plan months to legacy subscription users tables', () => {
    const db = createPublicSearchDatabase(':memory:');

    try {
      db.exec(`
        CREATE TABLE subscription_users (
          telegram_user_id INTEGER PRIMARY KEY,
          username TEXT,
          trial_started_at TEXT,
          trial_expires_at TEXT,
          trial_searches_used INTEGER NOT NULL DEFAULT 0,
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
          subscription_start_date,
          subscription_end_date,
          status,
          removed_from_group,
          created_at,
          updated_at
        )
        VALUES (
          42,
          'legacy_user',
          '2026-05-26',
          '2026-06-26',
          'Subscribe',
          0,
          '2026-05-26T00:00:00.000Z',
          '2026-05-26T00:00:00.000Z'
        );
      `);

      migratePublicSearchDatabase(db);

      const row = db
        .prepare('SELECT subscription_plan_months AS subscriptionPlanMonths FROM subscription_users WHERE telegram_user_id = 42')
        .get() as { subscriptionPlanMonths: number };

      expect(columnNames(db, 'subscription_users')).toContain('subscription_plan_months');
      expect(row.subscriptionPlanMonths).toBe(1);
    } finally {
      db.close();
    }
  });

  it('normalizes invalid legacy subscription plan months when adding the constraint', () => {
    const db = createPublicSearchDatabase(':memory:');

    try {
      db.exec(`
        CREATE TABLE subscription_users (
          telegram_user_id INTEGER PRIMARY KEY,
          username TEXT,
          trial_started_at TEXT,
          trial_expires_at TEXT,
          trial_searches_used INTEGER NOT NULL DEFAULT 0,
          subscription_start_date TEXT,
          subscription_end_date TEXT,
          subscription_plan_months INTEGER NOT NULL DEFAULT 1,
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
          subscription_start_date,
          subscription_end_date,
          subscription_plan_months,
          status,
          removed_from_group,
          created_at,
          updated_at
        )
        VALUES (
          42,
          'legacy_user',
          '2026-05-26',
          '2026-06-26',
          2,
          'Subscribe',
          0,
          '2026-05-26T00:00:00.000Z',
          '2026-05-26T00:00:00.000Z'
        );
      `);

      migratePublicSearchDatabase(db);

      const row = db
        .prepare('SELECT subscription_plan_months AS subscriptionPlanMonths FROM subscription_users WHERE telegram_user_id = 42')
        .get() as { subscriptionPlanMonths: number };

      expect(row.subscriptionPlanMonths).toBe(1);
      expect(tableSql(db, 'subscription_users')).toContain('CHECK (subscription_plan_months IN (1, 3, 6))');
      expect(() =>
        db.prepare('UPDATE subscription_users SET subscription_plan_months = 2 WHERE telegram_user_id = 42').run()
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('cascades movie provider rows when a movie is deleted', () => {
    const db = createMigratedDatabase();

    try {
      const movie = db
        .prepare(
          `INSERT INTO public_movies (id, title, year, telegram_message_id, channel_post_url)
           VALUES (1, 'Inception', 2010, 123, 'https://t.me/infinitylinks65/123')`
        )
        .run();

      db.prepare(
        `INSERT INTO public_movie_providers (movie_id, provider_name, quality, url, sort_order)
         VALUES (?, 'MixDrop', 'HD', 'https://mixdrop.example/movie', 1)`
      ).run(movie.lastInsertRowid);

      db.prepare('DELETE FROM public_movies WHERE id = ?').run(movie.lastInsertRowid);

      expect(db.prepare('SELECT COUNT(*) AS count FROM public_movie_providers').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('cascades TV child rows when a show is deleted', () => {
    const db = createMigratedDatabase();

    try {
      const show = db.prepare("INSERT INTO public_tv_shows (id, title, year) VALUES (1, 'Breaking Bad', 2008)").run();
      const season = db
        .prepare(
          `INSERT INTO public_seasons (id, tv_show_id, season_number, telegram_message_id, channel_post_url)
           VALUES (1, ?, 1, 201, 'https://t.me/infinitylinks65/201')`
        )
        .run(show.lastInsertRowid);
      const episode = db
        .prepare('INSERT INTO public_episodes (id, season_id, episode_number) VALUES (1, ?, 1)')
        .run(season.lastInsertRowid);

      db.prepare(
        `INSERT INTO public_episode_providers (episode_id, provider_name, quality, url, sort_order)
         VALUES (?, 'FileMoon', 'HD', 'https://filemoon.example/s1e1', 1)`
      ).run(episode.lastInsertRowid);

      db.prepare('DELETE FROM public_tv_shows WHERE id = ?').run(show.lastInsertRowid);

      expect(db.prepare('SELECT COUNT(*) AS count FROM public_seasons').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM public_episodes').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM public_episode_providers').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
