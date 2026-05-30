import { describe, expect, it, vi } from 'vitest';
import { replacePublicCatalog } from '../src/catalog.repository.js';
import { createPublicSearchDatabase, type PublicSearchDatabase } from '../src/db/database.js';
import { migratePublicSearchDatabase } from '../src/db/migrate.js';
import {
  applySubscriptionStartDate,
  consumeTrialSearchIfAllowed,
  markSubscriptionUserKicked,
  startTrialIfEligible,
  upsertSeenTelegramUser
} from '../src/subscriptions/repository.js';
import { createReplyThrottleState, handleTelegramUpdate, type HandlerDeps } from '../src/bot/handlers.js';
import { createPublicSearchInteractionRateLimiter } from '../src/bot/rate-policy.js';
import type { PublicSearchCatalog } from '../src/catalog.schema.js';
import type { InlineKeyboardMarkup, TelegramUpdate } from '../src/telegram.client.js';

const handles = {
  groupHandle: '@infinitylinks69'
};

const subscriptionRequiredMessage = [
  'A subscription is required to view and access download links.',
  '',
  'Plans:',
  '1 Month - ₱150',
  '3 Months - ₱300',
  '6 Months - ₱500',
  '',
  'Please contact @seinen_illuminatiks to continue.'
].join('\n');
const plansMessage = [
  'Plans:',
  '1 Month - ₱150',
  '3 Months - ₱300',
  '6 Months - ₱500',
  '',
  'Please contact @seinen_illuminatiks to subscribe.'
].join('\n');
const privateChatRequiredMessage = 'Open a private chat with this bot to view download links.';

type SentMessage = {
  chatId: number;
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
};

type CallbackAnswer = {
  callbackQueryId: string;
  text?: string;
};

type Provider = PublicSearchCatalog['movies'][number]['providers'][number];
type NonEmptyProviders = [Provider, ...Provider[]];

function providers(...items: NonEmptyProviders): NonEmptyProviders {
  return items;
}

function createMigratedDatabase() {
  const db = createPublicSearchDatabase(':memory:');
  migratePublicSearchDatabase(db);
  return db;
}

function seedCatalog(db: PublicSearchDatabase) {
  replacePublicCatalog(db, {
    generatedAt: '2026-05-24T00:00:00.000Z',
    groupHandle: handles.groupHandle,
    movies: [
      {
        id: 1,
        title: 'Inception',
        year: 2010,
        telegramMessageId: 101,
        channelPostUrl: 'https://t.me/infinitylinks65/101',
        providers: providers(
          {
            providerName: 'MixDrop',
            quality: 'HD',
            url: 'https://providers.example/inception-hd',
            sortOrder: 1
          },
          {
            providerName: 'FileMoon',
            quality: '4K',
            url: 'https://providers.example/inception-4k',
            sortOrder: 2
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
            url: `https://providers.example/limit-${index + 1}`,
            sortOrder: 1
          }
        )
      }))
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
            telegramMessageId: 301,
            channelPostUrl: 'https://t.me/infinitylinks65/301',
            episodes: [
              {
                episodeNumber: 1,
                providers: providers(
                  {
                    providerName: 'StreamTape',
                    quality: 'HD',
                    url: 'https://providers.example/breaking-s1e1',
                    sortOrder: 1
                  }
                )
              },
              {
                episodeNumber: 2,
                providers: providers(
                  {
                    providerName: 'MixDrop',
                    quality: 'HD',
                    url: 'https://providers.example/breaking-s1e2',
                    sortOrder: 1
                  }
                )
              }
            ]
          },
          {
            id: 31,
            seasonNumber: 2,
            telegramMessageId: 302,
            channelPostUrl: 'https://t.me/infinitylinks65/302',
            episodes: [
              {
                episodeNumber: 1,
                providers: providers(
                  {
                    providerName: 'FileMoon',
                    quality: '4K',
                    url: 'https://providers.example/breaking-s2e1',
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

function messageUpdate(text: string, overrides: Partial<TelegramUpdate['message']> = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: 500, type: 'private' },
      from: { id: 42 },
      text,
      ...overrides
    }
  };
}

function callbackUpdate(data: string | undefined, overrides: Partial<TelegramUpdate['callback_query']> = {}): TelegramUpdate {
  return {
    update_id: 2,
    callback_query: {
      id: 'callback-1',
      from: { id: 42 },
      message: {
        message_id: 11,
        chat: { id: 500, type: 'private' }
      },
      data,
      ...overrides
    }
  };
}

function createDeps(db: PublicSearchDatabase, overrides: Partial<HandlerDeps> = {}) {
  const sentMessages: SentMessage[] = [];
  const callbackAnswers: CallbackAnswer[] = [];
  const deps: HandlerDeps = {
    db,
    subscription: {
      now: () => new Date('2026-05-26T00:00:00.000Z'),
      trialSearchLimit: 5,
      adminContact: '@seinen_illuminatiks',
      scheduleSheetRefresh: vi.fn()
    },
    replies: {
      enqueueSendMessage: vi.fn(async (input: SentMessage) => {
        sentMessages.push(input);
      }),
      enqueueAnswerCallbackQuery: vi.fn(async (input: CallbackAnswer) => {
        callbackAnswers.push(input);
      })
    },
    rateLimiter: {
      check: vi.fn(() => ({ allowed: true as const }))
    },
    replyThrottleState: createReplyThrottleState(),
    ...handles,
    ...overrides
  };

  return { deps, sentMessages, callbackAnswers };
}

function seedTrialSearchAccess(db: PublicSearchDatabase, userId = 42) {
  const now = new Date('2026-05-26T00:00:00.000Z');
  startTrialIfEligible(db, { id: userId, username: 'trial_user' }, now);
  consumeTrialSearchIfAllowed(db, userId, now, 5);
}

describe('public search bot handlers', () => {
  it('replies to /start with usage without requiring subscription access', async () => {
    const db = createMigratedDatabase();

    try {
      const { deps, sentMessages } = createDeps(db);

      await handleTelegramUpdate(deps, messageUpdate('/start'));

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toContain('Welcome to DownloadHub');
      expect(sentMessages[0].text).toContain('/search movie or tv show name');
      expect(sentMessages[0].text).toContain('/plans');
      expect(sentMessages[0].replyMarkup).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('replies to /search with no query with validation without requiring subscription access', async () => {
    const db = createMigratedDatabase();

    try {
      const { deps, sentMessages } = createDeps(db);

      await handleTelegramUpdate(deps, messageUpdate('/search'));

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toBe(
        ['⚠️ Please provide a movie or TV show title.', '', 'Example: /search inception'].join('\n')
      );
      expect(sentMessages[0].replyMarkup).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('replies to /plans with plan pricing without requiring subscription access', async () => {
    const db = createMigratedDatabase();

    try {
      const { deps, sentMessages } = createDeps(db);

      await handleTelegramUpdate(deps, messageUpdate('/plans'));

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toBe(plansMessage);
      expect(sentMessages[0].replyMarkup).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('allows the first /start response even when the shared reply limiter would block', async () => {
    const db = createMigratedDatabase();

    try {
      const { deps, sentMessages } = createDeps(db, {
        rateLimiter: {
          check: vi.fn(() => ({ allowed: false as const, retryAfterMs: 60_000 }))
        }
      });

      await handleTelegramUpdate(deps, messageUpdate('/start', { from: { id: 99 } }));

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toContain('Welcome to DownloadHub');
    } finally {
      db.close();
    }
  });

  it('uses isolated first-start state per handler dependency object', async () => {
    const firstDb = createMigratedDatabase();
    const secondDb = createMigratedDatabase();

    try {
      const blockedLimiter = () => ({
        check: vi.fn(() => ({ allowed: false as const, retryAfterMs: 60_000 }))
      });
      const first = createDeps(firstDb, { rateLimiter: blockedLimiter() });
      const second = createDeps(secondDb, { rateLimiter: blockedLimiter() });

      await handleTelegramUpdate(first.deps, messageUpdate('/start', { from: { id: 99 } }));
      await handleTelegramUpdate(second.deps, messageUpdate('/start', { from: { id: 99 } }));

      expect(first.sentMessages).toHaveLength(1);
      expect(first.sentMessages[0].text).toContain('Welcome to DownloadHub');
      expect(second.sentMessages).toHaveLength(1);
      expect(second.sentMessages[0].text).toContain('Welcome to DownloadHub');
    } finally {
      firstDb.close();
      secondDb.close();
    }
  });

  it('uses the normal reply limiter for repeated /start commands', async () => {
    const db = createMigratedDatabase();

    try {
      const { deps, sentMessages } = createDeps(db, {
        rateLimiter: {
          check: vi.fn(() => ({ allowed: false as const, retryAfterMs: 60_000 }))
        }
      });

      await handleTelegramUpdate(deps, messageUpdate('/start', { from: { id: 99 } }));
      await handleTelegramUpdate(deps, messageUpdate('/start', { from: { id: 99 } }));

      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[0].text).toContain('Welcome to DownloadHub');
      expect(sentMessages[1].text).toBe('Please wait 60 seconds before trying again.');
    } finally {
      db.close();
    }
  });

  it('rate limits repeated low-value message replies before enqueueing them', async () => {
    const db = createMigratedDatabase();

    try {
      const { deps, sentMessages } = createDeps(db, {
        rateLimiter: {
          check: vi
            .fn()
            .mockReturnValueOnce({ allowed: true as const })
            .mockReturnValueOnce({ allowed: false as const, retryAfterMs: 30_000 })
        }
      });

      await handleTelegramUpdate(deps, messageUpdate('/plans'));
      await handleTelegramUpdate(deps, messageUpdate('/plans'));

      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[0].text).toContain('Plans:');
      expect(sentMessages[1].text).toBe('Please wait 30 seconds before trying again.');
    } finally {
      db.close();
    }
  });

  it('rate limits repeated unknown slash commands without requiring subscription access', async () => {
    const db = createMigratedDatabase();

    try {
      const { deps, sentMessages } = createDeps(db, {
        rateLimiter: {
          check: vi
            .fn()
            .mockReturnValueOnce({ allowed: true as const })
            .mockReturnValueOnce({ allowed: false as const, retryAfterMs: 30_000 })
        }
      });

      await handleTelegramUpdate(deps, messageUpdate('/wat'));
      await handleTelegramUpdate(deps, messageUpdate('/wat'));

      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[0].text).toContain('Welcome to DownloadHub');
      expect(sentMessages[1].text).toBe('Please wait 30 seconds before trying again.');
    } finally {
      db.close();
    }
  });

  it('does not enqueue repeated wait messages for already throttled users', async () => {
    const db = createMigratedDatabase();

    try {
      const { deps, sentMessages } = createDeps(db, {
        rateLimiter: {
          check: vi.fn(() => ({ allowed: false as const, retryAfterMs: 30_000 }))
        }
      });

      await handleTelegramUpdate(deps, messageUpdate('/plans'));
      await handleTelegramUpdate(deps, messageUpdate('/plans'));

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toBe('Please wait 30 seconds before trying again.');
    } finally {
      db.close();
    }
  });

  it('allows another wait message after the retry window expires', async () => {
    const db = createMigratedDatabase();
    let now = 1_000;

    try {
      const { deps, sentMessages } = createDeps(db, {
        rateLimiter: {
          check: vi.fn(() => ({ allowed: false as const, retryAfterMs: 30_000 }))
        },
        replyThrottleState: createReplyThrottleState({ now: () => now })
      });

      await handleTelegramUpdate(deps, messageUpdate('/plans'));
      await handleTelegramUpdate(deps, messageUpdate('/plans'));
      now += 30_000;
      await handleTelegramUpdate(deps, messageUpdate('/plans'));

      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[0].text).toBe('Please wait 30 seconds before trying again.');
      expect(sentMessages[1].text).toBe('Please wait 30 seconds before trying again.');
    } finally {
      db.close();
    }
  });

  it('rate limits callback replies before catalog details are loaded', async () => {
    const db = createMigratedDatabase();
    seedCatalog(db);

    try {
      const { deps, callbackAnswers, sentMessages } = createDeps(db, {
        rateLimiter: {
          check: vi.fn(() => ({ allowed: false as const, retryAfterMs: 10_000 }))
        }
      });

      await handleTelegramUpdate(deps, callbackUpdate('season:30'));

      expect(callbackAnswers).toEqual([
        {
          callbackQueryId: 'callback-1',
          text: 'Please wait 10 seconds before trying again.'
        }
      ]);
      expect(sentMessages).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('blocks /search after five successful trial searches', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const { deps, sentMessages } = createDeps(db);

      for (let index = 0; index < 5; index += 1) {
        await handleTelegramUpdate(
          deps,
          messageUpdate('/search inception', { from: { id: 42, username: 'trial_user' } })
        );
      }

      sentMessages.length = 0;
      await handleTelegramUpdate(
        deps,
        messageUpdate('/search inception', { from: { id: 42, username: 'trial_user' } })
      );

      const row = db
        .prepare(
          `SELECT status, trial_searches_used AS trialSearchesUsed
         FROM subscription_users
         WHERE telegram_user_id = 42`
        )
        .get() as { status: string; trialSearchesUsed: number } | undefined;

      expect(row).toMatchObject({ status: 'Trial', trialSearchesUsed: 5 });
      expect(sentMessages).toEqual([
        {
          chatId: 500,
          text: subscriptionRequiredMessage,
          replyMarkup: undefined
        }
      ]);
      expect(JSON.stringify(sentMessages)).not.toContain('providers.example');
    } finally {
      db.close();
    }
  });

  it('blocks exhausted trial users from season details', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const now = new Date('2026-05-26T00:00:00.000Z');
      startTrialIfEligible(db, { id: 42, username: 'trial_user' }, now);
      for (let index = 0; index < 5; index += 1) {
        consumeTrialSearchIfAllowed(db, 42, now, 5);
      }
      const { deps, sentMessages, callbackAnswers } = createDeps(db);

      await handleTelegramUpdate(deps, callbackUpdate('season:30', { from: { id: 42, username: 'trial_user' } }));

      expect(callbackAnswers).toEqual([{ callbackQueryId: 'callback-1', text: 'Subscription required.' }]);
      expect(sentMessages).toEqual([
        {
          chatId: 500,
          text: subscriptionRequiredMessage,
          replyMarkup: undefined
        }
      ]);
      expect(JSON.stringify({ sentMessages, callbackAnswers })).not.toContain('providers.example');
    } finally {
      db.close();
    }
  });

  it('does not start a trial from /start', async () => {
    const db = createMigratedDatabase();

    try {
      const { deps, sentMessages } = createDeps(db);

      await handleTelegramUpdate(deps, messageUpdate('/start', { from: { id: 42, username: 'trial_user' } }));

      const row = db.prepare('SELECT telegram_user_id FROM subscription_users WHERE telegram_user_id = 42').get();
      expect(row).toBeUndefined();
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toContain('Welcome to DownloadHub');
    } finally {
      db.close();
    }
  });

  it('starts a trial from the first /search and returns movie provider links', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const { deps, sentMessages } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        messageUpdate('/search inception', { from: { id: 42, username: 'trial_user' } })
      );

      const row = db
        .prepare(
          `SELECT status,
            trial_started_at AS trialStartedAt,
            trial_searches_used AS trialSearchesUsed
     FROM subscription_users
     WHERE telegram_user_id = 42`
        )
        .get() as { status: string; trialStartedAt: string | null; trialSearchesUsed: number } | undefined;
      expect(row).toMatchObject({ status: 'Trial', trialSearchesUsed: 1 });
      expect(row?.trialStartedAt).toBe('2026-05-26T00:00:00.000Z');
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toContain('🎬 Movie');
      expect(sentMessages[0].text).toContain('Inception (2010)');
      expect(sentMessages[0].text).toContain('🔗 Download Links:');
      expect(sentMessages[0].text).toContain('📁 MixDrop HD - https://providers.example/inception-hd');
      expect(sentMessages[0].text).toContain('📁 FileMoon 4K - https://providers.example/inception-4k');
      expect(sentMessages[0].text).not.toContain('📌 Original Post:');
      expect(sentMessages[0].text).not.toContain('https://t.me/infinitylinks65/101');
      expect(sentMessages[0].text).not.toContain('📢 Channel:');
      expect(sentMessages[0].text).not.toContain('👥 Group: @infinitylinks69');
      expect(sentMessages[0].replyMarkup).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('does not consume trial quota for no-result searches', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const { deps, sentMessages } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        messageUpdate('/search definitely-not-in-catalog', { from: { id: 42, username: 'trial_user' } })
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toBe('No results found. Try checking the spelling or using fewer words.');
      expect(
        db.prepare('SELECT telegram_user_id FROM subscription_users WHERE telegram_user_id = 42').get()
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('schedules a delayed sheet refresh when a trial starts from search', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const { deps } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        messageUpdate('/search inception', { from: { id: 42, username: 'trial_user' } })
      );

      expect(deps.subscription.scheduleSheetRefresh).toHaveBeenCalledTimes(1);
      expect(deps.subscription.scheduleSheetRefresh).toHaveBeenCalledWith(new Date('2026-05-26T00:00:00.000Z'));
    } finally {
      db.close();
    }
  });

  it('schedules a sheet refresh for an existing active subscriber search so username updates flow to Sheets', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      db.prepare(
        `INSERT INTO subscription_users (
           telegram_user_id, username, subscription_start_date, subscription_end_date, days_remaining,
           status, removed_from_group, created_at, updated_at
         )
         VALUES (42, 'paid_user', '2026-05-01', '2026-06-01', 6, 'Subscribe', 0, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`
      ).run();
      const { deps } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        messageUpdate('/search inception', { from: { id: 42, username: 'paid_user' } })
      );

      expect(deps.subscription.scheduleSheetRefresh).toHaveBeenCalledTimes(1);
      expect(deps.subscription.scheduleSheetRefresh).toHaveBeenCalledWith(new Date('2026-05-26T00:00:00.000Z'));
    } finally {
      db.close();
    }
  });

  it('returns movie provider links as text for an active paid subscriber', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const { deps, sentMessages } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        messageUpdate('/search inception', { from: { id: 42, username: 'paid_user' } })
      );
      applySubscriptionStartDate(db, 42, '2026-05-26', 1, new Date('2026-05-26T00:00:00.000Z'));
      sentMessages.length = 0;

      await handleTelegramUpdate(
        deps,
        messageUpdate('/search inception', { from: { id: 42, username: 'paid_user' } })
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toContain('Movie');
      expect(sentMessages[0].text).toContain('https://providers.example/inception-hd');
      expect(sentMessages[0].replyMarkup).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('keeps /search provider links out of group chats for otherwise allowed users', async () => {
    const db = createMigratedDatabase();
    const groupChatId = -100500;

    try {
      seedCatalog(db);
      const { deps, sentMessages } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        messageUpdate('/search inception', {
          chat: { id: groupChatId, type: 'group' },
          from: { id: 42, username: 'trial_user' }
        })
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].chatId).toBe(groupChatId);
      expect(sentMessages[0].text).toBe(privateChatRequiredMessage);
      expect(JSON.stringify(sentMessages)).not.toContain('providers.example');
      expect(deps.subscription.scheduleSheetRefresh).not.toHaveBeenCalled();
      expect(
        db.prepare('SELECT telegram_user_id FROM subscription_users WHERE telegram_user_id = 42').get()
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('returns TV season callback buttons for a trial user', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const { deps, sentMessages } = createDeps(db);

      await handleTelegramUpdate(deps, messageUpdate('/search breaking'));

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toContain('TV Show');
      expect(sentMessages[0].text).toContain('Breaking Bad (2008)');
      expect(sentMessages[0].replyMarkup).toEqual({
        inline_keyboard: [
          [
            { text: 'Season 1', callback_data: 'season:30' },
            { text: 'Season 2', callback_data: 'season:31' }
          ]
        ]
      });
    } finally {
      db.close();
    }
  });

  it('limits search results to 10 messages', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const { deps, sentMessages } = createDeps(db);

      await handleTelegramUpdate(deps, messageUpdate('/search limit match'));

      expect(sentMessages).toHaveLength(10);
      expect(sentMessages.map((message) => message.text.split('\n')[1])).toEqual([
        'Limit Match 01 (2010)',
        'Limit Match 02 (2011)',
        'Limit Match 03 (2012)',
        'Limit Match 04 (2013)',
        'Limit Match 05 (2014)',
        'Limit Match 06 (2015)',
        'Limit Match 07 (2016)',
        'Limit Match 08 (2017)',
        'Limit Match 09 (2018)',
        'Limit Match 10 (2019)'
      ]);
    } finally {
      db.close();
    }
  });

  it('returns unavailable when no catalog has been synced', async () => {
    const db = createMigratedDatabase();

    try {
      const { deps, sentMessages } = createDeps(db);

      await handleTelegramUpdate(deps, messageUpdate('/search inception'));

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toBe('Search is temporarily unavailable. Please try again later.');
    } finally {
      db.close();
    }
  });

  it('does not leak provider links when subscription is required during /search', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const now = new Date('2026-05-26T00:00:00.000Z');
      startTrialIfEligible(db, { id: 42, username: 'trial_user' }, now);
      for (let index = 0; index < 5; index += 1) {
        consumeTrialSearchIfAllowed(db, 42, now, 5);
      }
      const { deps, sentMessages } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        messageUpdate('/search inception', { from: { id: 42, username: 'trial_user' } })
      );

      expect(sentMessages).toEqual([
        {
          chatId: 500,
          text: subscriptionRequiredMessage,
          replyMarkup: undefined
        }
      ]);
      expect(JSON.stringify(sentMessages)).not.toContain('providers.example');
    } finally {
      db.close();
    }
  });

  it('throttles repeated subscription messages for blocked users', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const now = new Date('2026-05-26T00:00:00.000Z');
      startTrialIfEligible(db, { id: 42, username: 'trial_user' }, now);
      for (let index = 0; index < 5; index += 1) {
        consumeTrialSearchIfAllowed(db, 42, now, 5);
      }

      const { deps, sentMessages } = createDeps(db, {
        rateLimiter: createPublicSearchInteractionRateLimiter({ now: () => 0 })
      });

      for (let index = 0; index < 3; index += 1) {
        await handleTelegramUpdate(
          deps,
          messageUpdate('/search inception', { from: { id: 42, username: 'trial_user' } })
        );
      }

      await handleTelegramUpdate(
        deps,
        messageUpdate('/search inception', { from: { id: 42, username: 'trial_user' } })
      );

      expect(sentMessages.map((message) => message.text)).toEqual([
        subscriptionRequiredMessage,
        subscriptionRequiredMessage,
        subscriptionRequiredMessage,
        'Please wait 60 seconds before trying again.'
      ]);
    } finally {
      db.close();
    }
  });

  it('answers invalid callback data without leaking provider links', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const { deps, sentMessages, callbackAnswers } = createDeps(db);

      await handleTelegramUpdate(deps, callbackUpdate('movie:1'));

      expect(sentMessages).toEqual([]);
      expect(callbackAnswers).toEqual([{ callbackQueryId: 'callback-1', text: 'That button is no longer available.' }]);
    } finally {
      db.close();
    }
  });

  it('preserves invalid callback responses for blocked users', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      upsertSeenTelegramUser(db, { id: 42, username: 'kicked_user' }, new Date('2026-05-26T00:00:00.000Z'));
      markSubscriptionUserKicked(db, 42, new Date('2026-05-26T00:00:00.000Z'));
      const { deps, sentMessages, callbackAnswers } = createDeps(db);

      await handleTelegramUpdate(deps, callbackUpdate('movie:1', { from: { id: 42, username: 'kicked_user' } }));

      expect(sentMessages).toEqual([]);
      expect(callbackAnswers).toEqual([{ callbackQueryId: 'callback-1', text: 'That button is no longer available.' }]);
      expect(deps.rateLimiter.check).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('rate limits season callbacks with structured policy input before loading details', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const { deps, sentMessages, callbackAnswers } = createDeps(db, {
        rateLimiter: {
          check: vi.fn(() => ({ allowed: false, retryAfterMs: 3200 }))
        }
      });

      await handleTelegramUpdate(deps, callbackUpdate('season:30'));

      expect(deps.rateLimiter.check).toHaveBeenCalledWith({
        action: 'season',
        accessClass: 'trial-active',
        userId: 42
      });
      expect(sentMessages).toEqual([]);
      expect(callbackAnswers).toEqual([{ callbackQueryId: 'callback-1', text: 'Please wait 4 seconds before trying again.' }]);
    } finally {
      db.close();
    }
  });

  it('answers season callbacks before queueing season detail messages', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      seedTrialSearchAccess(db);
      const { deps } = createDeps(db);

      await handleTelegramUpdate(deps, callbackUpdate('season:30'));

      const answerOrder = vi.mocked(deps.replies.enqueueAnswerCallbackQuery).mock.invocationCallOrder[0];
      const sendOrder = vi.mocked(deps.replies.enqueueSendMessage).mock.invocationCallOrder[0];
      expect(answerOrder).toBeLessThan(sendOrder);
    } finally {
      db.close();
    }
  });

  it('schedules a sheet refresh for an allowed season callback', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      seedTrialSearchAccess(db);
      const { deps } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        callbackUpdate('season:30', { from: { id: 42, username: 'trial_user' } })
      );

      expect(deps.subscription.scheduleSheetRefresh).toHaveBeenCalledTimes(1);
      expect(deps.subscription.scheduleSheetRefresh).toHaveBeenCalledWith(new Date('2026-05-26T00:00:00.000Z'));
    } finally {
      db.close();
    }
  });

  it('keeps season callback provider links out of group chats for otherwise allowed users', async () => {
    const db = createMigratedDatabase();
    const groupChatId = -100501;

    try {
      seedCatalog(db);
      const { deps, sentMessages, callbackAnswers } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        callbackUpdate('season:30', {
          from: { id: 42, username: 'trial_user' },
          message: {
            message_id: 11,
            chat: { id: groupChatId, type: 'group' }
          }
        })
      );

      expect(callbackAnswers).toEqual([{ callbackQueryId: 'callback-1', text: privateChatRequiredMessage }]);
      expect(sentMessages).toHaveLength(0);
      expect(JSON.stringify({ sentMessages, callbackAnswers })).not.toContain('providers.example');
    } finally {
      db.close();
    }
  });

  it('answers season callbacks without a message before access and catalog side effects', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const { deps, sentMessages, callbackAnswers } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        callbackUpdate('season:30', {
          from: { id: 42, username: 'trial_user' },
          message: undefined
        })
      );

      expect(callbackAnswers).toEqual([{ callbackQueryId: 'callback-1', text: privateChatRequiredMessage }]);
      expect(sentMessages).toHaveLength(0);
      expect(deps.subscription.scheduleSheetRefresh).not.toHaveBeenCalled();
      expect(
        db.prepare('SELECT telegram_user_id FROM subscription_users WHERE telegram_user_id = 42').get()
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('answers blocked group season callbacks with subscription required without leaking provider links', async () => {
    const db = createMigratedDatabase();
    const groupChatId = -100502;

    try {
      seedCatalog(db);
      upsertSeenTelegramUser(db, { id: 42, username: 'kicked_user' }, new Date('2026-05-26T00:00:00.000Z'));
      markSubscriptionUserKicked(db, 42, new Date('2026-05-26T00:00:00.000Z'));
      const { deps, sentMessages, callbackAnswers } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        callbackUpdate('season:30', {
          from: { id: 42, username: 'kicked_user' },
          message: {
            message_id: 11,
            chat: { id: groupChatId, type: 'group' }
          }
        })
      );

      expect(callbackAnswers).toEqual([{ callbackQueryId: 'callback-1', text: 'Subscription required.' }]);
      expect(sentMessages).toEqual([
        {
          chatId: groupChatId,
          text: subscriptionRequiredMessage,
          replyMarkup: undefined
        }
      ]);
      expect(JSON.stringify({ sentMessages, callbackAnswers })).not.toContain('providers.example');
    } finally {
      db.close();
    }
  });

  it('answers blocked season callbacks without a message with subscription required only', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      upsertSeenTelegramUser(db, { id: 42, username: 'kicked_user' }, new Date('2026-05-26T00:00:00.000Z'));
      markSubscriptionUserKicked(db, 42, new Date('2026-05-26T00:00:00.000Z'));
      const { deps, sentMessages, callbackAnswers } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        callbackUpdate('season:30', {
          from: { id: 42, username: 'kicked_user' },
          message: undefined
        })
      );

      expect(callbackAnswers).toEqual([{ callbackQueryId: 'callback-1', text: 'Subscription required.' }]);
      expect(sentMessages).toEqual([]);
      expect(JSON.stringify({ sentMessages, callbackAnswers })).not.toContain('providers.example');
    } finally {
      db.close();
    }
  });

  it('throttles blocked season callback answers without leaking provider links', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      upsertSeenTelegramUser(db, { id: 42, username: 'kicked_user' }, new Date('2026-05-26T00:00:00.000Z'));
      markSubscriptionUserKicked(db, 42, new Date('2026-05-26T00:00:00.000Z'));
      const { deps, sentMessages, callbackAnswers } = createDeps(db, {
        rateLimiter: createPublicSearchInteractionRateLimiter({ now: () => 0 })
      });

      for (let index = 0; index < 3; index += 1) {
        await handleTelegramUpdate(deps, callbackUpdate('season:30', { from: { id: 42, username: 'kicked_user' } }));
      }

      callbackAnswers.length = 0;
      sentMessages.length = 0;
      await handleTelegramUpdate(deps, callbackUpdate('season:30', { from: { id: 42, username: 'kicked_user' } }));

      expect(callbackAnswers).toEqual([
        {
          callbackQueryId: 'callback-1',
          text: 'Please wait 60 seconds before trying again.'
        }
      ]);
      expect(sentMessages).toEqual([]);
      expect(JSON.stringify({ sentMessages, callbackAnswers })).not.toContain('providers.example');
    } finally {
      db.close();
    }
  });

  it('answers stale season callbacks before blocked access gates', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      upsertSeenTelegramUser(db, { id: 42, username: 'kicked_user' }, new Date('2026-05-26T00:00:00.000Z'));
      markSubscriptionUserKicked(db, 42, new Date('2026-05-26T00:00:00.000Z'));
      const { deps, sentMessages, callbackAnswers } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        callbackUpdate('season:999', { from: { id: 42, username: 'kicked_user' } })
      );

      expect(callbackAnswers).toEqual([{ callbackQueryId: 'callback-1', text: 'That button is no longer available.' }]);
      expect(sentMessages).toEqual([]);
      expect(JSON.stringify({ sentMessages, callbackAnswers })).not.toContain(subscriptionRequiredMessage);
      expect(JSON.stringify({ sentMessages, callbackAnswers })).not.toContain('providers.example');
    } finally {
      db.close();
    }
  });

  it('answers stale season callbacks before private chat gates', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const { deps, sentMessages, callbackAnswers } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        callbackUpdate('season:999', {
          message: {
            message_id: 11,
            chat: { id: -100502, type: 'group' }
          }
        })
      );

      expect(callbackAnswers).toEqual([{ callbackQueryId: 'callback-1', text: 'That button is no longer available.' }]);
      expect(callbackAnswers).not.toEqual([{ callbackQueryId: 'callback-1', text: privateChatRequiredMessage }]);
      expect(sentMessages).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('answers stale season callbacks before rate limits', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const rateLimitCheck = vi.fn(() => ({ allowed: false as const, retryAfterMs: 4500 }));
      const { deps, sentMessages, callbackAnswers } = createDeps(db, {
        rateLimiter: {
          check: rateLimitCheck
        }
      });

      await handleTelegramUpdate(deps, callbackUpdate('season:999'));

      expect(callbackAnswers).toEqual([{ callbackQueryId: 'callback-1', text: 'That button is no longer available.' }]);
      expect(callbackAnswers).not.toEqual([
        {
          callbackQueryId: 'callback-1',
          text: 'Please wait 5 seconds before trying again.'
        }
      ]);
      expect(sentMessages).toEqual([]);
      expect(rateLimitCheck).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('answers allowed group season callbacks after checking stale season details', async () => {
    const deniedDb = createMigratedDatabase();
    const unavailableDb = createMigratedDatabase();
    const groupChatId = -100502;
    const groupSeasonCallback = {
      from: { id: 42, username: 'trial_user' },
      message: {
        message_id: 11,
        chat: { id: groupChatId, type: 'group' }
      }
    } satisfies Partial<NonNullable<TelegramUpdate['callback_query']>>;

    try {
      seedCatalog(deniedDb);
      const denied = createDeps(deniedDb);

      await handleTelegramUpdate(denied.deps, callbackUpdate('season:30', groupSeasonCallback));

      expect(denied.callbackAnswers).toEqual([{ callbackQueryId: 'callback-1', text: privateChatRequiredMessage }]);
      expect(denied.sentMessages).toHaveLength(0);
      expect(denied.deps.subscription.scheduleSheetRefresh).not.toHaveBeenCalled();

      const unavailable = createDeps(unavailableDb);

      await handleTelegramUpdate(unavailable.deps, callbackUpdate('season:30', groupSeasonCallback));

      expect(unavailable.callbackAnswers).toEqual([
        { callbackQueryId: 'callback-1', text: 'That button is no longer available.' }
      ]);
      expect(unavailable.sentMessages).toHaveLength(0);
      expect(unavailable.deps.subscription.scheduleSheetRefresh).not.toHaveBeenCalled();
      expect(
        unavailableDb.prepare('SELECT telegram_user_id FROM subscription_users WHERE telegram_user_id = 42').get()
      ).toBeUndefined();
    } finally {
      deniedDb.close();
      unavailableDb.close();
    }
  });

  it('answers season callbacks even when sending season details fails', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      seedTrialSearchAccess(db);
      const callbackAnswers: CallbackAnswer[] = [];
      const { deps } = createDeps(db, {
        replies: {
          enqueueSendMessage: vi.fn(async () => {
            throw new Error('send failed');
          }),
          enqueueAnswerCallbackQuery: vi.fn(async (input: CallbackAnswer) => {
            callbackAnswers.push(input);
          })
        }
      });

      await expect(handleTelegramUpdate(deps, callbackUpdate('season:30'))).rejects.toThrow('send failed');

      expect(callbackAnswers).toEqual([{ callbackQueryId: 'callback-1' }]);
    } finally {
      db.close();
    }
  });

  it('does not consume trial quota for season callbacks', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const { deps } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        messageUpdate('/search breaking', { from: { id: 42, username: 'trial_user' } })
      );
      await handleTelegramUpdate(deps, callbackUpdate('season:30', { from: { id: 42, username: 'trial_user' } }));

      const row = db
        .prepare('SELECT trial_searches_used AS trialSearchesUsed FROM subscription_users WHERE telegram_user_id = 42')
        .get() as { trialSearchesUsed: number };

      expect(row.trialSearchesUsed).toBe(1);
    } finally {
      db.close();
    }
  });

  it('does not leak provider links when subscription is required during a season callback', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      upsertSeenTelegramUser(db, { id: 42, username: 'kicked_user' }, new Date('2026-05-26T00:00:00.000Z'));
      markSubscriptionUserKicked(db, 42, new Date('2026-05-26T00:00:00.000Z'));
      const { deps, sentMessages, callbackAnswers } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        callbackUpdate('season:30', { from: { id: 42, username: 'kicked_user' } })
      );

      expect(callbackAnswers).toEqual([{ callbackQueryId: 'callback-1', text: 'Subscription required.' }]);
      expect(sentMessages).toEqual([
        {
          chatId: 500,
          text: subscriptionRequiredMessage,
          replyMarkup: undefined
        }
      ]);
      expect(JSON.stringify({ sentMessages, callbackAnswers })).not.toContain('providers.example');
    } finally {
      db.close();
    }
  });

  it('checks subscription again before showing season callback results', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      upsertSeenTelegramUser(db, { id: 42, username: 'kicked_user' }, new Date('2026-05-26T00:00:00.000Z'));
      markSubscriptionUserKicked(db, 42, new Date('2026-05-26T00:00:00.000Z'));
      const { deps, sentMessages, callbackAnswers } = createDeps(db);

      await handleTelegramUpdate(
        deps,
        callbackUpdate('season:30', { from: { id: 42, username: 'kicked_user' } })
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toBe(subscriptionRequiredMessage);
      expect(sentMessages[0].text).not.toContain('providers.example');
      expect(sentMessages[0].replyMarkup).toBeUndefined();
      expect(callbackAnswers).toEqual([{ callbackQueryId: 'callback-1', text: 'Subscription required.' }]);
    } finally {
      db.close();
    }
  });

  it('returns episode-specific provider links as text for a season callback', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      seedTrialSearchAccess(db);
      const { deps, sentMessages, callbackAnswers } = createDeps(db);

      await handleTelegramUpdate(deps, callbackUpdate('season:30'));

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].text).toContain('📺 Breaking Bad (2008)');
      expect(sentMessages[0].text).toContain('📂 Season 1');
      expect(sentMessages[0].text).toContain('🎞 Episode 1');
      expect(sentMessages[0].text).toContain('🔗 Download Links:');
      expect(sentMessages[0].text).toContain('📁 StreamTape HD - https://providers.example/breaking-s1e1');
      expect(sentMessages[0].text).toContain('🎞 Episode 2');
      expect(sentMessages[0].text).toContain('📁 MixDrop HD - https://providers.example/breaking-s1e2');
      expect(sentMessages[0].text).not.toContain('📌 Original Post:');
      expect(sentMessages[0].text).not.toContain('https://t.me/infinitylinks65/301');
      expect(sentMessages[0].text).not.toContain('📢 Channel:');
      expect(sentMessages[0].text).not.toContain('👥 Group: @infinitylinks69');
      expect(sentMessages[0].replyMarkup).toBeUndefined();
      expect(callbackAnswers).toEqual([{ callbackQueryId: 'callback-1' }]);
    } finally {
      db.close();
    }
  });

  it('blocks spam with a wait message when the per-user rate limit is reached', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const { deps, sentMessages } = createDeps(db, {
        rateLimiter: {
          check: vi.fn(() => ({ allowed: false, retryAfterMs: 4500 }))
        }
      });

      await handleTelegramUpdate(deps, messageUpdate('/search inception'));

      expect(sentMessages).toEqual([
        {
          chatId: 500,
          text: 'Please wait 5 seconds before trying again.'
        }
      ]);
    } finally {
      db.close();
    }
  });

  it('uses paid search and season rate limits for subscribed users', async () => {
    const db = createMigratedDatabase();

    try {
      seedCatalog(db);
      const now = new Date('2026-05-26T00:00:00.000Z');
      startTrialIfEligible(db, { id: 42, username: 'paid_user' }, now);
      applySubscriptionStartDate(db, 42, '2026-05-26', 1, now);

      let nowMs = 0;
      const { deps, sentMessages, callbackAnswers } = createDeps(db, {
        subscription: {
          now: () => now,
          trialSearchLimit: 5,
          adminContact: '@seinen_illuminatiks',
          scheduleSheetRefresh: vi.fn()
        },
        rateLimiter: createPublicSearchInteractionRateLimiter({ now: () => nowMs })
      });

      for (let index = 0; index < 10; index += 1) {
        await handleTelegramUpdate(deps, messageUpdate('/search inception', { from: { id: 42, username: 'paid_user' } }));
      }

      sentMessages.length = 0;
      await handleTelegramUpdate(deps, messageUpdate('/search inception', { from: { id: 42, username: 'paid_user' } }));

      expect(sentMessages).toEqual([
        {
          chatId: 500,
          text: 'Please wait 60 seconds before trying again.'
        }
      ]);

      nowMs = 60_000;
      sentMessages.length = 0;

      for (let index = 0; index < 20; index += 1) {
        await handleTelegramUpdate(deps, callbackUpdate('season:30', { from: { id: 42, username: 'paid_user' } }));
      }

      callbackAnswers.length = 0;
      sentMessages.length = 0;
      await handleTelegramUpdate(deps, callbackUpdate('season:30', { from: { id: 42, username: 'paid_user' } }));

      expect(callbackAnswers).toEqual([
        {
          callbackQueryId: 'callback-1',
          text: 'Please wait 60 seconds before trying again.'
        }
      ]);
      expect(sentMessages).toEqual([]);
    } finally {
      db.close();
    }
  });
});
