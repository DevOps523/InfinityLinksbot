import type { PublicSearchDatabase } from './db/database.js';
import type { PublicSearchCatalog } from './catalog.schema.js';

export type PublicCatalogReplaceCounts = {
  movies: number;
  movieProviders: number;
  tvShows: number;
  seasons: number;
  episodes: number;
  episodeProviders: number;
};

export function replacePublicCatalog(db: PublicSearchDatabase, catalog: PublicSearchCatalog): PublicCatalogReplaceCounts {
  const replace = db.transaction(() => {
    const counts: PublicCatalogReplaceCounts = {
      movies: 0,
      movieProviders: 0,
      tvShows: 0,
      seasons: 0,
      episodes: 0,
      episodeProviders: 0
    };

    deleteExistingCatalog(db);

    const insertMovie = db.prepare(
      `INSERT INTO public_movies (id, title, year, telegram_message_id, channel_post_url)
       VALUES (@id, @title, @year, @telegramMessageId, @channelPostUrl)`
    );
    const insertMovieProvider = db.prepare(
      `INSERT INTO public_movie_providers (movie_id, provider_name, quality, url, sort_order)
       VALUES (@movieId, @providerName, @quality, @url, @sortOrder)`
    );
    const insertTvShow = db.prepare(
      `INSERT INTO public_tv_shows (id, title, year)
       VALUES (@id, @title, @year)`
    );
    const insertSeason = db.prepare(
      `INSERT INTO public_seasons (id, tv_show_id, season_number, telegram_message_id, channel_post_url)
       VALUES (@id, @tvShowId, @seasonNumber, @telegramMessageId, @channelPostUrl)`
    );
    const insertEpisode = db.prepare(
      `INSERT INTO public_episodes (season_id, episode_number)
       VALUES (@seasonId, @episodeNumber)`
    );
    const insertEpisodeProvider = db.prepare(
      `INSERT INTO public_episode_providers (episode_id, provider_name, quality, url, sort_order)
       VALUES (@episodeId, @providerName, @quality, @url, @sortOrder)`
    );

    for (const movie of catalog.movies) {
      insertMovie.run({
        id: movie.id,
        title: movie.title,
        year: movie.year ?? null,
        telegramMessageId: movie.telegramMessageId ?? null,
        channelPostUrl: movie.channelPostUrl ?? null
      });
      counts.movies += 1;

      for (const provider of movie.providers) {
        insertMovieProvider.run({
          movieId: movie.id,
          providerName: provider.providerName,
          quality: provider.quality,
          url: provider.url,
          sortOrder: provider.sortOrder
        });
        counts.movieProviders += 1;
      }
    }

    for (const tvShow of catalog.tvShows) {
      insertTvShow.run({
        id: tvShow.id,
        title: tvShow.title,
        year: tvShow.year ?? null
      });
      counts.tvShows += 1;

      for (const season of tvShow.seasons) {
        insertSeason.run({
          id: season.id,
          tvShowId: tvShow.id,
          seasonNumber: season.seasonNumber,
          telegramMessageId: season.telegramMessageId ?? null,
          channelPostUrl: season.channelPostUrl ?? null
        });
        counts.seasons += 1;

        for (const episode of season.episodes) {
          const episodeResult = insertEpisode.run({
            seasonId: season.id,
            episodeNumber: episode.episodeNumber
          });
          const episodeId = Number(episodeResult.lastInsertRowid);
          counts.episodes += 1;

          for (const provider of episode.providers) {
            insertEpisodeProvider.run({
              episodeId,
              providerName: provider.providerName,
              quality: provider.quality,
              url: provider.url,
              sortOrder: provider.sortOrder
            });
            counts.episodeProviders += 1;
          }
        }
      }
    }

    db.prepare(
      `INSERT INTO public_sync_state (id, last_successful_sync_at, generated_at)
       VALUES (1, @lastSuccessfulSyncAt, @generatedAt)
       ON CONFLICT(id) DO UPDATE SET
         last_successful_sync_at = excluded.last_successful_sync_at,
         generated_at = excluded.generated_at`
    ).run({
      lastSuccessfulSyncAt: new Date().toISOString(),
      generatedAt: catalog.generatedAt
    });

    return counts;
  });

  return replace();
}

function deleteExistingCatalog(db: PublicSearchDatabase) {
  db.prepare('DELETE FROM public_episode_providers').run();
  db.prepare('DELETE FROM public_episodes').run();
  db.prepare('DELETE FROM public_seasons').run();
  db.prepare('DELETE FROM public_tv_shows').run();
  db.prepare('DELETE FROM public_movie_providers').run();
  db.prepare('DELETE FROM public_movies').run();
}
