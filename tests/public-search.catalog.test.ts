import { describe, expect, it } from 'vitest';
import { PublicSearchCatalogSchema, type PublicSearchCatalog } from '../src/catalog.schema.js';

function createCatalog(overrides: Partial<PublicSearchCatalog> = {}) {
  return {
    generatedAt: '2026-05-24T00:00:00.000Z',
    channelHandle: '@infinitylinks65',
    groupHandle: '@infinitylinks69',
    movies: [
      {
        id: 1,
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
          }
        ]
      }
    ],
    tvShows: [
      {
        id: 10,
        title: 'Breaking Bad',
        year: 2008,
        seasons: [
          {
            id: 20,
            seasonNumber: 1,
            telegramMessageId: 201,
            channelPostUrl: 'https://t.me/infinitylinks65/201',
            episodes: [
              {
                episodeNumber: 1,
                providers: [
                  {
                    providerName: 'FileMoon',
                    quality: 'Full HD',
                    url: 'https://filemoon.example/breaking-bad/s1e1',
                    sortOrder: 1
                  },
                  {
                    providerName: 'MixDrop',
                    quality: 'HD',
                    url: 'https://mixdrop.example/breaking-bad/s1e1',
                    sortOrder: 2
                  }
                ]
              }
            ]
          }
        ]
      }
    ],
    ...overrides
  };
}

describe('public search catalog schema', () => {
  it('accepts a standalone catalog payload with movies and TV shows', () => {
    const catalog = PublicSearchCatalogSchema.parse(createCatalog());

    expect(catalog.movies).toEqual([
      {
        id: 1,
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
          }
        ]
      }
    ]);
    expect(catalog.tvShows[0]?.seasons[0]?.episodes[0]?.providers).toEqual([
      {
        providerName: 'FileMoon',
        quality: 'Full HD',
        url: 'https://filemoon.example/breaking-bad/s1e1',
        sortOrder: 1
      },
      {
        providerName: 'MixDrop',
        quality: 'HD',
        url: 'https://mixdrop.example/breaking-bad/s1e1',
        sortOrder: 2
      }
    ]);
  });

  it('allows catalogs with only movies or only TV shows', () => {
    expect(PublicSearchCatalogSchema.parse(createCatalog({ tvShows: [] })).tvShows).toEqual([]);
    expect(PublicSearchCatalogSchema.parse(createCatalog({ movies: [] })).movies).toEqual([]);
  });

  it('rejects catalog entries without playable providers', () => {
    const result = PublicSearchCatalogSchema.safeParse(
      createCatalog({
        movies: [
          {
            id: 1,
            title: 'Inception',
            providers: []
          }
        ]
      })
    );

    expect(result.success).toBe(false);
  });

  it('rejects duplicate movie, show, season, and episode identifiers', () => {
    const catalog = createCatalog({
      movies: [
        {
          id: 1,
          title: 'Alpha',
          providers: [
            {
              providerName: 'FirstHost',
              quality: 'HD',
              url: 'https://first.example/alpha',
              sortOrder: 1
            }
          ]
        },
        {
          id: 1,
          title: 'Alpha Copy',
          providers: [
            {
              providerName: 'SecondHost',
              quality: 'HD',
              url: 'https://second.example/alpha',
              sortOrder: 1
            }
          ]
        }
      ],
      tvShows: [
        {
          id: 10,
          title: 'Alpha',
          seasons: [
            {
              id: 20,
              seasonNumber: 1,
              episodes: [
                {
                  episodeNumber: 1,
                  providers: [
                    {
                      providerName: 'EpisodeHost',
                      quality: 'HD',
                      url: 'https://episode.example/s1e1',
                      sortOrder: 1
                    }
                  ]
                },
                {
                  episodeNumber: 1,
                  providers: [
                    {
                      providerName: 'EpisodeHost',
                      quality: 'HD',
                      url: 'https://episode.example/s1e1-copy',
                      sortOrder: 1
                    }
                  ]
                }
              ]
            },
            {
              id: 20,
              seasonNumber: 1,
              episodes: [
                {
                  episodeNumber: 2,
                  providers: [
                    {
                      providerName: 'EpisodeHost',
                      quality: 'HD',
                      url: 'https://episode.example/s1e2',
                      sortOrder: 1
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          id: 10,
          title: 'Alpha Copy',
          seasons: [
            {
              id: 21,
              seasonNumber: 1,
              episodes: [
                {
                  episodeNumber: 1,
                  providers: [
                    {
                      providerName: 'EpisodeHost',
                      quality: 'HD',
                      url: 'https://episode.example/copy-s1e1',
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

    const result = PublicSearchCatalogSchema.safeParse(catalog);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          'Duplicate movie id',
          'Duplicate TV show id',
          'Duplicate season number',
          'Duplicate season id',
          'Duplicate episode number'
        ])
      );
    }
  });
});
