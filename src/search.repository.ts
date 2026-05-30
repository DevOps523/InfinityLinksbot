import type { PublicSearchDatabase as AppDatabase } from './db/database.js';

export type PublicProvider = {
  providerName: string;
  quality: string;
  url: string;
  sortOrder: number;
};

export type PublicSeasonSummary = {
  id: number;
  seasonNumber: number;
};

export type PublicSeasonDetails = {
  id: number;
  showTitle: string;
  showYear?: number | undefined;
  seasonNumber: number;
  channelPostUrl?: string | undefined;
  episodes: Array<{
    episodeNumber: number;
    providers: PublicProvider[];
  }>;
};

export type PublicSearchResult =
  | {
      type: 'movie';
      id: number;
      title: string;
      year?: number | undefined;
      channelPostUrl?: string | undefined;
      providers: PublicProvider[];
    }
  | { type: 'tv'; id: number; title: string; year?: number | undefined; seasons: PublicSeasonSummary[] };

type SearchRow = {
  type: 'movie' | 'tv';
  id: number;
  title: string;
  year: number | null;
  channelPostUrl: string | null;
};

type ProviderRow = {
  providerName: string;
  quality: string;
  url: string;
  sortOrder: number;
};

type SeasonRow = {
  id: number;
  seasonNumber: number;
};

type EpisodeRow = {
  id: number;
  episodeNumber: number;
};

type SeasonDetailsRow = {
  id: number;
  showTitle: string;
  showYear: number | null;
  seasonNumber: number;
  channelPostUrl: string | null;
};

export function searchPublicCatalog(db: AppDatabase, query: string, limit = 10): PublicSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery || limit <= 0) {
    return [];
  }

  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 10;
  const rows = db
    .prepare(
      `SELECT type, id, title, year, channelPostUrl
       FROM (
         SELECT
           'movie' AS type,
           id,
           title,
           year,
           channel_post_url AS channelPostUrl,
           CASE
             WHEN LOWER(title) = @query THEN 0
             WHEN LOWER(title) LIKE @prefix ESCAPE '\\' THEN 1
             ELSE 2
           END AS rank
         FROM public_movies
         WHERE LOWER(title) LIKE @substring ESCAPE '\\'
           AND EXISTS (
             SELECT 1
             FROM public_movie_providers
             WHERE public_movie_providers.movie_id = public_movies.id
           )
         UNION ALL
         SELECT
           'tv' AS type,
           id,
           title,
           year,
           NULL AS channelPostUrl,
           CASE
             WHEN LOWER(title) = @query THEN 0
             WHEN LOWER(title) LIKE @prefix ESCAPE '\\' THEN 1
             ELSE 2
           END AS rank
         FROM public_tv_shows
         WHERE LOWER(title) LIKE @substring ESCAPE '\\'
           AND EXISTS (
             SELECT 1
             FROM public_seasons
             JOIN public_episodes ON public_episodes.season_id = public_seasons.id
             JOIN public_episode_providers ON public_episode_providers.episode_id = public_episodes.id
             WHERE public_seasons.tv_show_id = public_tv_shows.id
           )
       )
       ORDER BY rank, title COLLATE NOCASE, year, type
       LIMIT @limit`
    )
    .all({
      query: normalizedQuery,
      prefix: `${escapeLike(normalizedQuery)}%`,
      substring: `%${escapeLike(normalizedQuery)}%`,
      limit: safeLimit
    }) as SearchRow[];

  return rows.map((row) => {
    if (row.type === 'movie') {
      return {
        type: 'movie',
        id: row.id,
        title: row.title,
        year: row.year ?? undefined,
        channelPostUrl: row.channelPostUrl ?? undefined,
        providers: getMovieProviders(db, row.id)
      };
    }

    return {
      type: 'tv',
      id: row.id,
      title: row.title,
      year: row.year ?? undefined,
      seasons: getTvSeasonSummaries(db, row.id)
    };
  });
}

export function getPublicSeasonDetails(db: AppDatabase, seasonId: number): PublicSeasonDetails | undefined {
  const season = db
    .prepare(
      `SELECT
         public_seasons.id,
         public_tv_shows.title AS showTitle,
         public_tv_shows.year AS showYear,
         public_seasons.season_number AS seasonNumber,
         public_seasons.channel_post_url AS channelPostUrl
       FROM public_seasons
       JOIN public_tv_shows ON public_tv_shows.id = public_seasons.tv_show_id
       WHERE public_seasons.id = ?`
    )
    .get(seasonId) as SeasonDetailsRow | undefined;

  if (!season) {
    return undefined;
  }

  const episodes = db
    .prepare(
      `SELECT id, episode_number AS episodeNumber
       FROM public_episodes
       WHERE season_id = ?
         AND EXISTS (
           SELECT 1
           FROM public_episode_providers
           WHERE public_episode_providers.episode_id = public_episodes.id
         )
       ORDER BY episode_number, id`
    )
    .all(seasonId) as EpisodeRow[];

  return {
    id: season.id,
    showTitle: season.showTitle,
    showYear: season.showYear ?? undefined,
    seasonNumber: season.seasonNumber,
    channelPostUrl: season.channelPostUrl ?? undefined,
    episodes: episodes.map((episode) => ({
      episodeNumber: episode.episodeNumber,
      providers: getEpisodeProviders(db, episode.id)
    }))
  };
}

export function hasPublicCatalog(db: AppDatabase): boolean {
  const row = db.prepare('SELECT 1 FROM public_sync_state WHERE id = 1 AND last_successful_sync_at IS NOT NULL').get();
  return Boolean(row);
}

function getMovieProviders(db: AppDatabase, movieId: number): PublicProvider[] {
  return db
    .prepare(
      `SELECT
         provider_name AS providerName,
         quality,
         url,
         sort_order AS sortOrder
       FROM public_movie_providers
       WHERE movie_id = ?
       ORDER BY sort_order, id`
    )
    .all(movieId) as ProviderRow[];
}

function getTvSeasonSummaries(db: AppDatabase, tvShowId: number): PublicSeasonSummary[] {
  return db
    .prepare(
      `SELECT id, season_number AS seasonNumber
       FROM public_seasons
       WHERE tv_show_id = ?
         AND EXISTS (
           SELECT 1
           FROM public_episodes
           JOIN public_episode_providers ON public_episode_providers.episode_id = public_episodes.id
           WHERE public_episodes.season_id = public_seasons.id
         )
       ORDER BY season_number, id`
    )
    .all(tvShowId) as SeasonRow[];
}

function getEpisodeProviders(db: AppDatabase, episodeId: number): PublicProvider[] {
  return db
    .prepare(
      `SELECT
         provider_name AS providerName,
         quality,
         url,
         sort_order AS sortOrder
       FROM public_episode_providers
       WHERE episode_id = ?
       ORDER BY sort_order, id`
    )
    .all(episodeId) as ProviderRow[];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
