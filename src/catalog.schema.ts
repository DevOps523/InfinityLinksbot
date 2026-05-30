import { z } from 'zod';

const PositiveIntegerSchema = z.number().int().positive();

const OptionalPositiveIntegerSchema = PositiveIntegerSchema.optional();

const HTTP_URL_ERROR_MESSAGE = 'URL must use http or https';

function isHttpUrl(value: string) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const HttpUrlSchema = z.string().url().refine(isHttpUrl, {
  message: HTTP_URL_ERROR_MESSAGE
});

export const PublicSearchProviderSchema = z
  .object({
    providerName: z.string().trim().min(1),
    quality: z.string().trim().min(1),
    url: HttpUrlSchema,
    sortOrder: PositiveIntegerSchema
  })
  .strict();

export const PublicSearchMovieSchema = z
  .object({
    id: PositiveIntegerSchema,
    title: z.string().trim().min(1),
    year: OptionalPositiveIntegerSchema,
    telegramMessageId: OptionalPositiveIntegerSchema,
    channelPostUrl: HttpUrlSchema.optional(),
    providers: PublicSearchProviderSchema.array().nonempty()
  })
  .strict();

export const PublicSearchEpisodeSchema = z
  .object({
    episodeNumber: PositiveIntegerSchema,
    providers: PublicSearchProviderSchema.array().nonempty()
  })
  .strict();

export const PublicSearchSeasonSchema = z
  .object({
    id: PositiveIntegerSchema,
    seasonNumber: PositiveIntegerSchema,
    telegramMessageId: OptionalPositiveIntegerSchema,
    channelPostUrl: HttpUrlSchema.optional(),
    episodes: PublicSearchEpisodeSchema.array().nonempty()
  })
  .strict();

export const PublicSearchTvShowSchema = z
  .object({
    id: PositiveIntegerSchema,
    title: z.string().trim().min(1),
    year: OptionalPositiveIntegerSchema,
    seasons: PublicSearchSeasonSchema.array().nonempty()
  })
  .strict();

export const PublicSearchCatalogSchema = z
  .object({
    generatedAt: z.string().datetime(),
    channelHandle: z.string().trim().min(1),
    groupHandle: z.string().trim().min(1),
    movies: PublicSearchMovieSchema.array(),
    tvShows: PublicSearchTvShowSchema.array()
  })
  .strict()
  .superRefine((catalog, ctx) => {
    addDuplicateIdIssues(
      ctx,
      catalog.movies,
      (movie) => movie.id,
      (index) => ['movies', index, 'id'],
      'Duplicate movie id'
    );
    addDuplicateIdIssues(
      ctx,
      catalog.tvShows,
      (tvShow) => tvShow.id,
      (index) => ['tvShows', index, 'id'],
      'Duplicate TV show id'
    );

    const seenSeasonIds = new Set<number>();
    for (const [tvShowIndex, tvShow] of catalog.tvShows.entries()) {
      addDuplicateIdIssues(
        ctx,
        tvShow.seasons,
        (season) => season.seasonNumber,
        (seasonIndex) => ['tvShows', tvShowIndex, 'seasons', seasonIndex, 'seasonNumber'],
        'Duplicate season number'
      );

      for (const [seasonIndex, season] of tvShow.seasons.entries()) {
        if (seenSeasonIds.has(season.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tvShows', tvShowIndex, 'seasons', seasonIndex, 'id'],
            message: 'Duplicate season id'
          });
        }
        seenSeasonIds.add(season.id);

        addDuplicateIdIssues(
          ctx,
          season.episodes,
          (episode) => episode.episodeNumber,
          (episodeIndex) => ['tvShows', tvShowIndex, 'seasons', seasonIndex, 'episodes', episodeIndex, 'episodeNumber'],
          'Duplicate episode number'
        );
      }
    }
  });

export type PublicSearchCatalog = z.infer<typeof PublicSearchCatalogSchema>;

function addDuplicateIdIssues<T>(
  ctx: z.RefinementCtx,
  items: T[],
  getValue: (item: T) => number,
  getPath: (index: number) => Array<number | string>,
  message: string
) {
  const seen = new Set<number>();
  for (const [index, item] of items.entries()) {
    const value = getValue(item);
    if (seen.has(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: getPath(index),
        message
      });
    }
    seen.add(value);
  }
}
