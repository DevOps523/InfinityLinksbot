import { describe, expect, it } from 'vitest';
import { replacePublicCatalog } from '../src/catalog.repository.js';
import type { PublicSearchCatalog } from '../src/catalog.schema.js';
import { createPublicSearchDatabase, type PublicSearchDatabase } from '../src/db/database.js';
import { migratePublicSearchDatabase } from '../src/db/migrate.js';
import {
  getPublicSeasonDetails,
  hasPublicCatalog,
  searchPublicCatalog
} from '../src/search.repository.js';

function createMigratedDatabase() {
  const db = createPublicSearchDatabase(':memory:');
  migratePublicSearchDatabase(db);
  return db;
}

type Provider = PublicSearchCatalog['movies'][number]['providers'][number];
type NonEmptyProviders = [Provider, ...Provider[]];

function providers(...items: NonEmptyProviders): NonEmptyProviders {
  return items;
}

function seedCatalog(db: PublicSearchDatabase) {
  replacePublicCatalog(db, {
    generatedAt: '2026-05-24T00:00:00.000Z',
    channelHandle: '@infinitylinks65',
    groupHandle: '@infinitylinks69',
    movies: [
      {
        id: 1,
        title: 'Alpha',
        year: 2000,
        telegramMessageId: 101,
        channelPostUrl: 'https://t.me/infinitylinks65/101',
        providers: providers(
          {
            providerName: 'LateHost',
            quality: '4K',
            url: 'https://late.example/alpha',
            sortOrder: 2
          },
          {
            providerName: 'FirstHost',
            quality: 'HD',
            url: 'https://first.example/alpha',
            sortOrder: 1
          }
        )
      },
      {
        id: 2,
        title: 'Alpha Force',
        year: 2001,
        telegramMessageId: 102,
        channelPostUrl: 'https://t.me/infinitylinks65/102',
        providers: providers(
          {
            providerName: 'MovieHost',
            quality: 'HD',
            url: 'https://movie.example/alpha-force',
            sortOrder: 1
          }
        )
      },
      {
        id: 3,
        title: 'The Alpha Code',
        year: 2002,
        telegramMessageId: 103,
        channelPostUrl: 'https://t.me/infinitylinks65/103',
        providers: providers(
          {
            providerName: 'CodeHost',
            quality: 'HD',
            url: 'https://code.example/the-alpha-code',
            sortOrder: 1
          }
        )
      },
      {
        id: 4,
        title: 'Case File',
        year: 2020,
        telegramMessageId: 104,
        channelPostUrl: 'https://t.me/infinitylinks65/104',
        providers: providers(
          {
            providerName: 'CaseHost',
            quality: 'HD',
            url: 'https://case.example/file',
            sortOrder: 1
          }
        )
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: 100 + index,
        title: `Limit Match ${String(index + 1).padStart(2, '0')}`,
        year: 2010 + index,
        telegramMessageId: 200 + index,
        channelPostUrl: `https://t.me/infinitylinks65/${200 + index}`,
        providers: providers(
          {
            providerName: 'LimitHost',
            quality: 'HD',
            url: `https://limit.example/${index + 1}`,
            sortOrder: 1
          }
        )
      }))
    ],
    tvShows: [
      {
        id: 10,
        title: 'Alpha',
        year: 2011,
        seasons: [
          {
            id: 20,
            seasonNumber: 2,
            telegramMessageId: 302,
            channelPostUrl: 'https://t.me/infinitylinks65/302',
            episodes: [
              {
                episodeNumber: 2,
                providers: providers(
                  {
                    providerName: 'EpisodeLate',
                    quality: '4K',
                    url: 'https://episode.example/s2e2-late',
                    sortOrder: 2
                  },
                  {
                    providerName: 'EpisodeFirst',
                    quality: 'HD',
                    url: 'https://episode.example/s2e2-first',
                    sortOrder: 1
                  }
                )
              },
              {
                episodeNumber: 1,
                providers: providers(
                  {
                    providerName: 'EpisodeOne',
                    quality: 'HD',
                    url: 'https://episode.example/s2e1',
                    sortOrder: 1
                  }
                )
              }
            ]
          },
          {
            id: 19,
            seasonNumber: 1,
            telegramMessageId: 301,
            channelPostUrl: 'https://t.me/infinitylinks65/301',
            episodes: [
              {
                episodeNumber: 1,
                providers: providers(
                  {
                    providerName: 'SeasonOne',
                    quality: 'HD',
                    url: 'https://episode.example/s1e1',
                    sortOrder: 1
                  }
                )
              }
            ]
          }
        ]
      },
      {
        id: 11,
        title: 'Alpha Patrol',
        year: 2012,
        seasons: [
          {
            id: 21,
            seasonNumber: 1,
            telegramMessageId: 303,
            channelPostUrl: 'https://t.me/infinitylinks65/303',
            episodes: [
              {
                episodeNumber: 1,
                providers: providers(
                  {
                    providerName: 'PatrolHost',
                    quality: 'HD',
                    url: 'https://episode.example/patrol-s1e1',
                    sortOrder: 1
                  }
                )
              }
            ]
          }
        ]
      },
      {
        id: 12,
        title: 'The Alpha Files',
        year: 2013,
        seasons: [
          {
            id: 22,
            seasonNumber: 1,
            telegramMessageId: 304,
            channelPostUrl: 'https://t.me/infinitylinks65/304',
            episodes: [
              {
                episodeNumber: 1,
                providers: providers(
                  {
                    providerName: 'FilesHost',
                    quality: 'HD',
                    url: 'https://episode.example/files-s1e1',
                    sortOrder: 1
                  }
                )
              }
            ]
          }
        ]
      },
      {
        id: 13,
        title: 'Mixed Case Show',
        year: 2021,
        seasons: [
          {
            id: 23,
            seasonNumber: 1,
            telegramMessageId: 305,
            channelPostUrl: 'https://t.me/infinitylinks65/305',
            episodes: [
              {
                episodeNumber: 1,
                providers: providers(
                  {
                    providerName: 'CaseTvHost',
                    quality: 'HD',
                    url: 'https://episode.example/mixed-case-s1e1',
                    sortOrder: 1
                  }
                )
              }
            ]
          }
        ]
      }
    ]
  });
}

describe('public search repository', () => {
  it('searches movies and TV shows case-insensitively with ranked partial matches and a default limit', () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);

      const results = searchPublicCatalog(db, 'alpha');

      expect(results).toHaveLength(6);
      expect(results.map((result) => `${result.type}:${result.title}:${result.year ?? ''}`)).toEqual([
        'movie:Alpha:2000',
        'tv:Alpha:2011',
        'movie:Alpha Force:2001',
        'tv:Alpha Patrol:2012',
        'movie:The Alpha Code:2002',
        'tv:The Alpha Files:2013'
      ]);
      expect(searchPublicCatalog(db, 'cAsE').map((result) => `${result.type}:${result.title}`)).toEqual([
        'movie:Case File',
        'tv:Mixed Case Show'
      ]);
    } finally {
      db.close();
    }
  });

  it('limits search results to 10 by default', () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);

      const results = searchPublicCatalog(db, 'limit match');

      expect(results).toHaveLength(10);
      expect(results.map((result) => result.title)).toEqual([
        'Limit Match 01',
        'Limit Match 02',
        'Limit Match 03',
        'Limit Match 04',
        'Limit Match 05',
        'Limit Match 06',
        'Limit Match 07',
        'Limit Match 08',
        'Limit Match 09',
        'Limit Match 10'
      ]);
    } finally {
      db.close();
    }
  });

  it('includes movie providers and TV seasons with providers in stable child order', () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);

      const results = searchPublicCatalog(db, 'alpha', 2);

      expect(results[0]).toEqual({
        type: 'movie',
        id: 1,
        title: 'Alpha',
        year: 2000,
        channelPostUrl: 'https://t.me/infinitylinks65/101',
        providers: [
          {
            providerName: 'FirstHost',
            quality: 'HD',
            url: 'https://first.example/alpha',
            sortOrder: 1
          },
          {
            providerName: 'LateHost',
            quality: '4K',
            url: 'https://late.example/alpha',
            sortOrder: 2
          }
        ]
      });
      expect(results[1]).toEqual({
        type: 'tv',
        id: 10,
        title: 'Alpha',
        year: 2011,
        seasons: [
          { id: 19, seasonNumber: 1 },
          { id: 20, seasonNumber: 2 }
        ]
      });
    } finally {
      db.close();
    }
  });

  it('returns selected season details with episodes and providers in stable order', () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);

      expect(getPublicSeasonDetails(db, 20)).toEqual({
        id: 20,
        showTitle: 'Alpha',
        showYear: 2011,
        seasonNumber: 2,
        channelPostUrl: 'https://t.me/infinitylinks65/302',
        episodes: [
          {
            episodeNumber: 1,
            providers: [
              {
                providerName: 'EpisodeOne',
                quality: 'HD',
                url: 'https://episode.example/s2e1',
                sortOrder: 1
              }
            ]
          },
          {
            episodeNumber: 2,
            providers: [
              {
                providerName: 'EpisodeFirst',
                quality: 'HD',
                url: 'https://episode.example/s2e2-first',
                sortOrder: 1
              },
              {
                providerName: 'EpisodeLate',
                quality: '4K',
                url: 'https://episode.example/s2e2-late',
                sortOrder: 2
              }
            ]
          }
        ]
      });
      expect(getPublicSeasonDetails(db, 999)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('reports whether a public catalog has been synced', () => {
    const db = createMigratedDatabase();

    try {
      expect(hasPublicCatalog(db)).toBe(false);

      seedCatalog(db);

      expect(hasPublicCatalog(db)).toBe(true);
    } finally {
      db.close();
    }
  });
});
