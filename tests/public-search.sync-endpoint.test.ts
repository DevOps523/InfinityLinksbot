import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createPublicSearchApp } from '../src/app.js';
import type { PublicSearchCatalog } from '../src/catalog.schema.js';
import type { PublicSearchConfig } from '../src/config.js';
import { createPublicSearchDatabase, type PublicSearchDatabase } from '../src/db/database.js';
import { migratePublicSearchDatabase } from '../src/db/migrate.js';
import { createPublicSearchStatusTracker } from '../src/status-tracker.js';
import { createPublicSearchSyncRouter } from '../src/sync.routes.js';

function createMigratedDatabase() {
  const db = createPublicSearchDatabase(':memory:');
  migratePublicSearchDatabase(db);
  return db;
}

function createConfig(overrides: Partial<PublicSearchConfig> = {}): PublicSearchConfig {
  return {
    publicBotToken: 'bot-token',
    publicSearchSyncToken: 'sync-token',
    publicSearchStatusToken: 'status-token',
    publicSearchGroupHandle: '@infinitylinks69',
    publicSearchDatabasePath: ':memory:',
    publicSearchHost: '127.0.0.1',
    publicSearchPort: 3001,
    ...overrides
  };
}

function createTracker() {
  return createPublicSearchStatusTracker({
    now: () => new Date('2026-05-24T00:00:00.000Z'),
    uptimeSeconds: () => 12
  });
}

function validCatalog(): PublicSearchCatalog {
  return {
    generatedAt: '2026-05-24T00:00:00.000Z',
    channelHandle: '@infinitylinks65',
    groupHandle: '@infinitylinks69',
    movies: [
      {
        id: 10,
        title: 'Inception',
        year: 2010,
        telegramMessageId: 123,
        channelPostUrl: 'https://t.me/infinitylinks65/123',
        providers: [
          {
            providerName: 'MixDrop',
            quality: 'HD',
            url: 'https://mixdrop.example/movie',
            sortOrder: 1
          },
          {
            providerName: 'FileMoon',
            quality: '4K',
            url: 'https://filemoon.example/movie',
            sortOrder: 2
          }
        ]
      }
    ],
    tvShows: [
      {
        id: 20,
        title: 'Breaking Bad',
        year: 2008,
        seasons: [
          {
            id: 30,
            seasonNumber: 1,
            telegramMessageId: 201,
            channelPostUrl: 'https://t.me/infinitylinks65/201',
            episodes: [
              {
                episodeNumber: 1,
                providers: [
                  {
                    providerName: 'StreamTape',
                    quality: 'HD',
                    url: 'https://streamtape.example/s1e1',
                    sortOrder: 1
                  }
                ]
              },
              {
                episodeNumber: 2,
                providers: [
                  {
                    providerName: 'MixDrop',
                    quality: 'HD',
                    url: 'https://mixdrop.example/s1e2',
                    sortOrder: 1
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}

function seedOldCatalog(db: PublicSearchDatabase) {
  db.prepare(
    `INSERT INTO public_movies (id, title, year, telegram_message_id, channel_post_url)
     VALUES (1, 'Old Movie', 1999, 999, 'https://t.me/infinitylinks65/999')`
  ).run();
  db.prepare(
    `INSERT INTO public_movie_providers (movie_id, provider_name, quality, url, sort_order)
     VALUES (1, 'OldHost', 'SD', 'https://old.example/movie', 1)`
  ).run();
  db.prepare(
    `INSERT INTO public_sync_state (id, last_successful_sync_at, generated_at)
     VALUES (1, '2026-05-23T00:00:00.000Z', '2026-05-23T00:00:00.000Z')`
  ).run();
}

function tableCount(db: PublicSearchDatabase, table: string) {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function expectOldCatalogPreserved(db: PublicSearchDatabase) {
  expect(db.prepare('SELECT title FROM public_movies WHERE id = 1').get()).toEqual({ title: 'Old Movie' });
  expect(tableCount(db, 'public_movie_providers')).toBe(1);
}

describe('public search sync endpoint', () => {
  it('returns 401 when the bearer token is missing', async () => {
    const db = createMigratedDatabase();

    try {
      const tracker = createTracker();
      const app = createPublicSearchApp({ db, config: createConfig(), statusTracker: tracker });

      const response = await request(app).post('/api/sync').send(validCatalog());

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
      expect(tracker.snapshot()).toMatchObject({
        state: 'ok',
        consecutiveErrorCount: 0,
        lastError: null
      });
    } finally {
      db.close();
    }
  });

  it('returns 401 when the bearer token is wrong', async () => {
    const db = createMigratedDatabase();

    try {
      const tracker = createTracker();
      const app = createPublicSearchApp({ db, config: createConfig(), statusTracker: tracker });

      const response = await request(app).post('/api/sync').set('Authorization', 'Bearer wrong-token').send(validCatalog());

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
      expect(tracker.snapshot()).toMatchObject({
        state: 'ok',
        consecutiveErrorCount: 0,
        lastError: null
      });
    } finally {
      db.close();
    }
  });

  it('rejects invalid bearer tokens before parsing invalid large JSON bodies', async () => {
    const db = createMigratedDatabase();

    try {
      const config = createConfig();
      const router = createPublicSearchSyncRouter(db, config, createTracker());
      let bodyConsumed = false;
      const req = new Readable({
        read() {
          bodyConsumed = true;
          this.push('{');
          this.push(null);
        }
      }) as Request;
      const response = {
        body: undefined as unknown,
        statusCode: 200,
        headers: {} as Record<string, string>,
        json(body: unknown) {
          this.body = body;
          return this;
        },
        set(name: string, value: string) {
          this.headers[name.toLowerCase()] = value;
          return this;
        },
        status(statusCode: number) {
          this.statusCode = statusCode;
          return this;
        }
      } as Response & { body: unknown; statusCode: number; headers: Record<string, string> };

      req.method = 'POST';
      req.url = '/sync';
      req.headers = {
        authorization: 'Bearer wrong-token',
        'content-length': String(1024 * 1024 + 1),
        'content-type': 'application/json'
      };
      req.ip = '127.0.0.1';
      req.header = (name: string) => req.headers[name.toLowerCase()] as string | undefined;
      req.resume = () => {
        bodyConsumed = true;
        return req;
      };

      await new Promise<void>((resolve, reject) => {
        router.handle(req, response, reject);
        setImmediate(resolve);
      });

      expect(response.statusCode).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
      expect(bodyConsumed).toBe(false);
    } finally {
      db.close();
    }
  });

  it('rate limits repeated invalid bearer tokens without parsing request bodies', async () => {
    const db = createMigratedDatabase();

    try {
      const app = createPublicSearchApp({ db, config: createConfig() });

      for (let index = 0; index < 10; index += 1) {
        await request(app)
          .post('/api/sync')
          .set('Authorization', 'Bearer wrong-token')
          .set('Content-Type', 'application/json')
          .send('{')
          .expect(401);
      }

      const response = await request(app)
        .post('/api/sync')
        .set('Authorization', 'Bearer wrong-token')
        .set('Content-Type', 'application/json')
        .send('{');

      expect(response.status).toBe(429);
      expect(response.body).toEqual({ error: 'Too many unauthorized sync attempts. Please wait and try again.' });
    } finally {
      db.close();
    }
  });

  it('returns 429 when valid sync requests exceed the per-token IP limit', async () => {
    const db = createMigratedDatabase();

    try {
      const tracker = createTracker();
      const app = createPublicSearchApp({ db, config: createConfig(), statusTracker: tracker });

      for (let index = 0; index < 5; index += 1) {
        await request(app).post('/api/sync').set('Authorization', 'Bearer sync-token').send(validCatalog()).expect(200);
      }

      const response = await request(app).post('/api/sync').set('Authorization', 'Bearer sync-token').send(validCatalog());

      expect(response.status).toBe(429);
      expect(Number(response.header['retry-after'])).toBeGreaterThan(0);
      expect(Number(response.header['retry-after'])).toBeLessThanOrEqual(60);
      expect(response.body).toEqual({ error: 'Too many sync attempts. Please wait and try again.' });
      expect(tracker.snapshot()).toMatchObject({
        state: 'ok',
        consecutiveErrorCount: 0,
        lastError: null
      });
    } finally {
      db.close();
    }
  });

  it('respects forwarded client IPs from a trusted local proxy for sync rate limiting', async () => {
    const db = createMigratedDatabase();

    try {
      const app = createPublicSearchApp({ db, config: createConfig() });

      for (let index = 0; index < 5; index += 1) {
        await request(app)
          .post('/api/sync')
          .set('Authorization', 'Bearer sync-token')
          .set('X-Forwarded-For', '198.51.100.10')
          .send(validCatalog())
          .expect(200);
      }

      await request(app)
        .post('/api/sync')
        .set('Authorization', 'Bearer sync-token')
        .set('X-Forwarded-For', '198.51.100.10')
        .send(validCatalog())
        .expect(429);

      await request(app)
        .post('/api/sync')
        .set('Authorization', 'Bearer sync-token')
        .set('X-Forwarded-For', '198.51.100.20')
        .send(validCatalog())
        .expect(200);
    } finally {
      db.close();
    }
  });

  it('does not count invalid-token sync attempts against the valid-token quota', async () => {
    const db = createMigratedDatabase();

    try {
      const app = createPublicSearchApp({ db, config: createConfig() });

      for (let index = 0; index < 6; index += 1) {
        await request(app).post('/api/sync').set('Authorization', 'Bearer wrong-token').send(validCatalog()).expect(401);
      }

      await request(app).post('/api/sync').set('Authorization', 'Bearer sync-token').send(validCatalog()).expect(200);
    } finally {
      db.close();
    }
  });

  it('returns 400 for invalid payloads and preserves old data', async () => {
    const db = createMigratedDatabase();

    try {
      seedOldCatalog(db);
      const tracker = createTracker();
      const app = createPublicSearchApp({ db, config: createConfig(), statusTracker: tracker });

      const response = await request(app)
        .post('/api/sync')
        .set('Authorization', 'Bearer sync-token')
        .send({
          ...validCatalog(),
          movies: [
            {
              ...validCatalog().movies[0],
              providers: [{ providerName: 'BadHost', quality: 'HD', url: 'not-a-url', sortOrder: 1 }]
            }
          ]
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'movies.0.providers.0.url',
            message: expect.any(String)
          })
        ])
      );
      expect(tracker.snapshot()).toMatchObject({
        state: 'error',
        consecutiveErrorCount: 1,
        lastError: {
          source: 'sync',
          at: '2026-05-24T00:00:00.000Z'
        }
      });
      expectOldCatalogPreserved(db);
    } finally {
      db.close();
    }
  });

  it('returns 400 for unsafe provider URL schemes', async () => {
    const db = createMigratedDatabase();

    try {
      const catalog = validCatalog();
      catalog.movies[0].providers[0].url = 'javascript:alert(1)';
      const app = createPublicSearchApp({ db, config: createConfig() });

      const response = await request(app).post('/api/sync').set('Authorization', 'Bearer sync-token').send(catalog);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'movies.0.providers.0.url',
            message: 'URL must use http or https'
          })
        ])
      );
      expect(JSON.stringify(response.body)).toContain('URL must use http or https');
    } finally {
      db.close();
    }
  });

  it('returns a generic client error for malformed JSON', async () => {
    const db = createMigratedDatabase();

    try {
      const app = createPublicSearchApp({ db, config: createConfig() });

      const response = await request(app)
        .post('/api/sync')
        .set('Authorization', 'Bearer sync-token')
        .set('Content-Type', 'application/json')
        .send('{"generatedAt":');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid request body' });
    } finally {
      db.close();
    }
  });

  it('does not count valid-token malformed JSON against the valid sync quota', async () => {
    const db = createMigratedDatabase();

    try {
      const app = createPublicSearchApp({ db, config: createConfig() });

      for (let index = 0; index < 6; index += 1) {
        const response = await request(app)
          .post('/api/sync')
          .set('Authorization', 'Bearer sync-token')
          .set('Content-Type', 'application/json')
          .send('{"generatedAt":');

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'Invalid request body' });
      }

      await request(app).post('/api/sync').set('Authorization', 'Bearer sync-token').send(validCatalog()).expect(200);
    } finally {
      db.close();
    }
  });

  it('returns 413 for oversized valid-token JSON without counting against the valid sync quota', async () => {
    const db = createMigratedDatabase();

    try {
      const app = createPublicSearchApp({ db, config: createConfig() });
      const oversizedBody = JSON.stringify({
        ...validCatalog(),
        padding: 'x'.repeat(5 * 1024 * 1024)
      });

      const response = await request(app)
        .post('/api/sync')
        .set('Authorization', 'Bearer sync-token')
        .set('Content-Type', 'application/json')
        .send(oversizedBody);

      expect(response.status).toBe(413);
      expect(response.body).toEqual({ error: 'Request body too large' });

      await request(app).post('/api/sync').set('Authorization', 'Bearer sync-token').send(validCatalog()).expect(200);
    } finally {
      db.close();
    }
  });

  it('returns 400 for empty nested arrays and preserves old data', async () => {
    const db = createMigratedDatabase();

    try {
      seedOldCatalog(db);
      const catalog = validCatalog();
      const app = createPublicSearchApp({ db, config: createConfig() });

      const response = await request(app)
        .post('/api/sync')
        .set('Authorization', 'Bearer sync-token')
        .send({
          ...catalog,
          movies: [
            {
              ...catalog.movies[0],
              providers: []
            }
          ],
          tvShows: [
            {
              id: 21,
              title: 'Empty Seasons',
              seasons: []
            },
            {
              id: 22,
              title: 'Empty Episodes',
              seasons: [
                {
                  id: 31,
                  seasonNumber: 1,
                  episodes: []
                }
              ]
            },
            {
              id: 23,
              title: 'Empty Episode Providers',
              seasons: [
                {
                  id: 32,
                  seasonNumber: 1,
                  episodes: [
                    {
                      episodeNumber: 1,
                      providers: []
                    }
                  ]
                }
              ]
            }
          ]
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'movies.0.providers' }),
          expect.objectContaining({ path: 'tvShows.0.seasons' }),
          expect.objectContaining({ path: 'tvShows.1.seasons.0.episodes' }),
          expect.objectContaining({ path: 'tvShows.2.seasons.0.episodes.0.providers' })
        ])
      );
      expectOldCatalogPreserved(db);
    } finally {
      db.close();
    }
  });

  it('returns 400 for duplicate catalog IDs and episode numbers and preserves old data', async () => {
    const db = createMigratedDatabase();

    try {
      seedOldCatalog(db);
      const catalog = validCatalog();
      const app = createPublicSearchApp({ db, config: createConfig() });

      const response = await request(app)
        .post('/api/sync')
        .set('Authorization', 'Bearer sync-token')
        .send({
          ...catalog,
          movies: [
            catalog.movies[0],
            {
              ...catalog.movies[0],
              title: 'Duplicate Movie'
            }
          ],
          tvShows: [
            catalog.tvShows[0],
            {
              id: catalog.tvShows[0].id,
              title: 'Duplicate Show',
              seasons: [
                {
                  id: catalog.tvShows[0].seasons[0].id,
                  seasonNumber: 2,
                  episodes: [
                    {
                      episodeNumber: 1,
                      providers: [
                        {
                          providerName: 'FileMoon',
                          quality: 'HD',
                          url: 'https://filemoon.example/duplicate-show',
                          sortOrder: 1
                        }
                      ]
                    },
                    {
                      episodeNumber: 1,
                      providers: [
                        {
                          providerName: 'MixDrop',
                          quality: 'HD',
                          url: 'https://mixdrop.example/duplicate-episode',
                          sortOrder: 1
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'movies.1.id' }),
          expect.objectContaining({ path: 'tvShows.1.id' }),
          expect.objectContaining({ path: 'tvShows.1.seasons.0.id' }),
          expect.objectContaining({ path: 'tvShows.1.seasons.0.episodes.1.episodeNumber' })
        ])
      );
      expectOldCatalogPreserved(db);
    } finally {
      db.close();
    }
  });

  it('returns 400 for duplicate season numbers under the same TV show and preserves old data', async () => {
    const db = createMigratedDatabase();

    try {
      seedOldCatalog(db);
      const catalog = validCatalog();
      const app = createPublicSearchApp({ db, config: createConfig() });

      const response = await request(app)
        .post('/api/sync')
        .set('Authorization', 'Bearer sync-token')
        .send({
          ...catalog,
          tvShows: [
            {
              ...catalog.tvShows[0],
              seasons: [
                catalog.tvShows[0].seasons[0],
                {
                  id: 31,
                  seasonNumber: catalog.tvShows[0].seasons[0].seasonNumber,
                  telegramMessageId: 202,
                  channelPostUrl: 'https://t.me/infinitylinks65/202',
                  episodes: [
                    {
                      episodeNumber: 1,
                      providers: [
                        {
                          providerName: 'FileMoon',
                          quality: 'HD',
                          url: 'https://filemoon.example/same-season-number',
                          sortOrder: 1
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'tvShows.0.seasons.1.seasonNumber' })])
      );
      expectOldCatalogPreserved(db);
    } finally {
      db.close();
    }
  });

  it('replaces the old catalog transactionally for a valid payload', async () => {
    const db = createMigratedDatabase();

    try {
      seedOldCatalog(db);
      const tracker = createTracker();
      tracker.recordError('sync', new Error('Previous sync failed'));
      const app = createPublicSearchApp({ db, config: createConfig(), statusTracker: tracker });

      const response = await request(app).post('/api/sync').set('Authorization', 'Bearer sync-token').send(validCatalog());

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        sync: {
          movies: 1,
          movieProviders: 2,
          tvShows: 1,
          seasons: 1,
          episodes: 2,
          episodeProviders: 2
        }
      });
      expect(tracker.snapshot()).toMatchObject({
        state: 'ok',
        consecutiveErrorCount: 0,
        lastError: null
      });

      expect(db.prepare('SELECT id, title, year, telegram_message_id, channel_post_url FROM public_movies').all()).toEqual([
        {
          id: 10,
          title: 'Inception',
          year: 2010,
          telegram_message_id: 123,
          channel_post_url: 'https://t.me/infinitylinks65/123'
        }
      ]);
      expect(db.prepare('SELECT provider_name, quality, url, sort_order FROM public_movie_providers ORDER BY id').all()).toEqual([
        {
          provider_name: 'MixDrop',
          quality: 'HD',
          url: 'https://mixdrop.example/movie',
          sort_order: 1
        },
        {
          provider_name: 'FileMoon',
          quality: '4K',
          url: 'https://filemoon.example/movie',
          sort_order: 2
        }
      ]);
      expect(db.prepare('SELECT id, title, year FROM public_tv_shows').all()).toEqual([
        {
          id: 20,
          title: 'Breaking Bad',
          year: 2008
        }
      ]);
      expect(
        db.prepare('SELECT id, tv_show_id, season_number, telegram_message_id, channel_post_url FROM public_seasons').all()
      ).toEqual([
        {
          id: 30,
          tv_show_id: 20,
          season_number: 1,
          telegram_message_id: 201,
          channel_post_url: 'https://t.me/infinitylinks65/201'
        }
      ]);
      expect(db.prepare('SELECT season_id, episode_number FROM public_episodes ORDER BY episode_number').all()).toEqual([
        {
          season_id: 30,
          episode_number: 1
        },
        {
          season_id: 30,
          episode_number: 2
        }
      ]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM public_movies WHERE title = 'Old Movie'").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('accepts and stores TV seasons without channel post fields during repost windows', async () => {
    const db = createMigratedDatabase();

    try {
      const catalog = validCatalog();
      const season = catalog.tvShows[0].seasons[0];
      catalog.tvShows[0].seasons[0] = {
        id: 30,
        seasonNumber: 1,
        episodes: season.episodes
      };

      const app = createPublicSearchApp({ db, config: createConfig() });

      await request(app).post('/api/sync').set('Authorization', 'Bearer sync-token').send(catalog).expect(200);

      expect(
        db.prepare('SELECT telegram_message_id, channel_post_url FROM public_seasons WHERE id = 30').get()
      ).toEqual({
        telegram_message_id: null,
        channel_post_url: null
      });
    } finally {
      db.close();
    }
  });

  it('records last_successful_sync_at after a valid sync', async () => {
    const db = createMigratedDatabase();

    try {
      const app = createPublicSearchApp({ db, config: createConfig() });

      const response = await request(app).post('/api/sync').set('Authorization', 'Bearer sync-token').send(validCatalog());

      expect(response.status).toBe(200);
      const syncState = db
        .prepare('SELECT last_successful_sync_at, generated_at FROM public_sync_state WHERE id = 1')
        .get() as { last_successful_sync_at: string; generated_at: string };

      expect(syncState.generated_at).toBe('2026-05-24T00:00:00.000Z');
      expect(new Date(syncState.last_successful_sync_at).toISOString()).toBe(syncState.last_successful_sync_at);
    } finally {
      db.close();
    }
  });
});
