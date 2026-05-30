import { describe, expect, it } from 'vitest';
import type { PublicSearchResult, PublicSeasonDetails } from '../src/search.repository.js';
import {
  formatNoResultsMessage,
  formatPlansMessage,
  formatSearchResults,
  formatSearchValidationMessage,
  formatSeasonDetails,
  formatStartMessage,
  formatSubscriptionRequiredMessage,
  formatUnavailableMessage,
  MAX_INLINE_KEYBOARD_BUTTONS,
  MAX_INLINE_KEYBOARD_ROWS,
  MAX_FORMATTED_MESSAGE_LENGTH
} from '../src/bot/formatter.js';
import { decodeSeasonCallback, encodeSeasonCallback } from '../src/bot/callback-data.js';

const handles = {
  groupHandle: '@infinitylinks69'
};

describe('public search bot formatter', () => {
  it('formats command and status messages', () => {
    expect(formatStartMessage(handles).text).toBe(
      [
        '🎬 Welcome to DownloadHub',
        '',
        '🔎 Use:',
        '/search movie or tv show name',
        '/plans',
        '',
        '✨ Examples:',
        '/search inception',
        '/search breaking bad',
        '',
        'You get 10 free movie or TV searches.',
        'After that, subscription is required to keep going.'
      ].join('\n')
    );
    expect(formatStartMessage(handles).replyMarkup).toBeUndefined();

    expect(formatSearchValidationMessage().text).toBe(
      ['⚠️ Please provide a movie or TV show title.', '', 'Example: /search inception'].join('\n')
    );
    expect(formatSearchValidationMessage().replyMarkup).toBeUndefined();

    expect(formatPlansMessage('@seinen_illuminatiks').text).toBe(
      [
        'Plans:',
        '1 Month - ₱150',
        '3 Months - ₱300',
        '6 Months - ₱500',
        '',
        'Please contact @seinen_illuminatiks to subscribe.'
      ].join('\n')
    );
    expect(formatPlansMessage('@seinen_illuminatiks').replyMarkup).toBeUndefined();

    expect(formatSubscriptionRequiredMessage('@seinen_illuminatiks').text).toBe(
      [
        'A subscription is required to view and access download links.',
        '',
        'Plans:',
        '1 Month - ₱150',
        '3 Months - ₱300',
        '6 Months - ₱500',
        '',
        'Please contact @seinen_illuminatiks to continue.'
      ].join('\n')
    );

    expect(formatNoResultsMessage(handles).text).toBe('No results found. Try checking the spelling or using fewer words.');
    expect(formatNoResultsMessage(handles).replyMarkup).toBeUndefined();
    expect(formatUnavailableMessage().text).toBe('Search is temporarily unavailable. Please try again later.');
  });

  it('formats movie results with provider URL buttons', () => {
    const results: PublicSearchResult[] = [
      {
        type: 'movie',
        id: 1,
        title: 'Inception',
        year: 2010,
        channelPostUrl: 'https://t.me/infinitylinks65/101',
        providers: [
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
        ]
      }
    ];

    const messages = formatSearchResults(results, handles);

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe(
      [
        '🎬 Movie',
        'Inception (2010)',
        '',
        '🔗 Download Links:',
        '📁 MixDrop HD - https://providers.example/inception-hd',
        '📁 FileMoon 4K - https://providers.example/inception-4k'
      ].join('\n')
    );
    expect(messages[0].replyMarkup).toBeUndefined();
  });

  it('formats many movie providers as text download links', () => {
    const results: PublicSearchResult[] = [
      {
        type: 'movie',
        id: 1,
        title: 'Provider Test',
        year: 2026,
        providers: Array.from({ length: 5 }, (_, index) => ({
          providerName: `Host${index + 1}`,
          quality: 'HD',
          url: `https://providers.example/movie-${index + 1}`,
          sortOrder: index + 1
        }))
      }
    ];

    const messages = formatSearchResults(results, handles);

    expect(messages).toHaveLength(1);
    for (let index = 1; index <= 5; index += 1) {
      expect(messages[0].text).toContain(`📁 Host${index} HD - https://providers.example/movie-${index}`);
    }
    expect(messages[0].replyMarkup).toBeUndefined();
  });

  it('splits movie result text before Telegram message length is exceeded', () => {
    const results: PublicSearchResult[] = [
      {
        type: 'movie',
        id: 1,
        title: 'Provider Limit',
        year: 2026,
        channelPostUrl: 'https://t.me/infinitylinks65/401',
        providers: Array.from({ length: 80 }, (_, index) => ({
          providerName: `Host${index + 1}`,
          quality: 'HD',
          url: `https://providers.example/provider-limit-${index + 1}-${'x'.repeat(80)}`,
          sortOrder: index + 1
        }))
      }
    ];

    const messages = formatSearchResults(results, handles);

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.text).toContain('Provider Limit (2026)');
      expect(message.text.length).toBeLessThanOrEqual(MAX_FORMATTED_MESSAGE_LENGTH);
      expect(message.replyMarkup).toBeUndefined();
    }
    expect(messages[0].text).toContain('🎬 Movie');
    expect(messages[0].text).toContain('🔗 Download Links:');
  });

  it('formats TV results with season callback buttons', () => {
    const results: PublicSearchResult[] = [
      {
        type: 'tv',
        id: 10,
        title: 'Breaking Bad',
        year: 2008,
        seasons: [
          { id: 101, seasonNumber: 1 },
          { id: 102, seasonNumber: 2 }
        ]
      }
    ];

    const messages = formatSearchResults(results, handles);

    expect(encodeSeasonCallback(101)).toBe('season:101');
    expect(decodeSeasonCallback('season:102')).toBe(102);
    expect(decodeSeasonCallback('movie:102')).toBeUndefined();
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe(
      [
        '📺 TV Show',
        'Breaking Bad (2008)',
        '',
        '📂 Choose a season:'
      ].join('\n')
    );
    expect(messages[0].replyMarkup).toEqual({
      inline_keyboard: [
        [
          { text: 'Season 1', callback_data: 'season:101' },
          { text: 'Season 2', callback_data: 'season:102' }
        ]
      ]
    });
  });

  it('chunks many TV season callback buttons into small rows', () => {
    const results: PublicSearchResult[] = [
      {
        type: 'tv',
        id: 10,
        title: 'Season Test',
        year: 2026,
        seasons: Array.from({ length: 7 }, (_, index) => ({
          id: 201 + index,
          seasonNumber: index + 1
        }))
      }
    ];

    const messages = formatSearchResults(results, handles);

    expect(messages[0].replyMarkup?.inline_keyboard).toEqual([
      [
        { text: 'Season 1', callback_data: 'season:201' },
        { text: 'Season 2', callback_data: 'season:202' },
        { text: 'Season 3', callback_data: 'season:203' }
      ],
      [
        { text: 'Season 4', callback_data: 'season:204' },
        { text: 'Season 5', callback_data: 'season:205' },
        { text: 'Season 6', callback_data: 'season:206' }
      ],
      [{ text: 'Season 7', callback_data: 'season:207' }]
    ]);
  });

  it('splits TV season keyboards before Telegram limits are exceeded', () => {
    const results: PublicSearchResult[] = [
      {
        type: 'tv',
        id: 10,
        title: 'Season Limit',
        year: 2026,
        seasons: Array.from({ length: 40 }, (_, index) => ({
          id: 300 + index,
          seasonNumber: index + 1
        }))
      }
    ];

    const messages = formatSearchResults(results, handles);

    expect(messages).toHaveLength(1);
    for (const message of messages) {
      const rows = message.replyMarkup?.inline_keyboard ?? [];

      expect(message.text).toContain('Season Limit (2026)');
      expect(rows.length).toBeLessThanOrEqual(MAX_INLINE_KEYBOARD_ROWS);
      expect(rows.reduce((total, row) => total + row.length, 0)).toBeLessThanOrEqual(MAX_INLINE_KEYBOARD_BUTTONS);
    }
    expect(messages[0].replyMarkup?.inline_keyboard.at(-1)).toEqual([{ text: 'Season 40', callback_data: 'season:339' }]);
  });

  it('formats season details with provider links grouped by episode', () => {
    const details: PublicSeasonDetails = {
      id: 101,
      showTitle: 'Breaking Bad',
      showYear: 2008,
      seasonNumber: 1,
      channelPostUrl: 'https://t.me/infinitylinks65/301',
      episodes: [
        {
          episodeNumber: 1,
          providers: [
            {
              providerName: 'MixDrop',
              quality: 'HD',
              url: 'https://providers.example/breaking-bad-s1e1-hd',
              sortOrder: 1
            },
            {
              providerName: 'FileMoon',
              quality: '4K',
              url: 'https://providers.example/breaking-bad-s1e1-4k',
              sortOrder: 2
            }
          ]
        },
        {
          episodeNumber: 2,
          providers: [
            {
              providerName: 'StreamTape',
              quality: 'HD',
              url: 'https://providers.example/breaking-bad-s1e2-hd',
              sortOrder: 1
            }
          ]
        }
      ]
    };

    const messages = formatSeasonDetails(details, handles);

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe(
      [
        '📺 Breaking Bad (2008)',
        '📂 Season 1',
        '',
        '🎞 Episode 1',
        '🔗 Download Links:',
        '📁 MixDrop HD - https://providers.example/breaking-bad-s1e1-hd',
        '📁 FileMoon 4K - https://providers.example/breaking-bad-s1e1-4k',
        '',
        '🎞 Episode 2',
        '🔗 Download Links:',
        '📁 StreamTape HD - https://providers.example/breaking-bad-s1e2-hd'
      ].join('\n')
    );
    expect(messages[0].replyMarkup).toBeUndefined();
  });

  it('formats season details without an Original Post section when channel post url is missing', () => {
    const details: PublicSeasonDetails = {
      id: 301,
      showTitle: 'Repost Show',
      showYear: 2026,
      seasonNumber: 1,
      episodes: [
        {
          episodeNumber: 1,
          providers: [
            {
              providerName: 'Filekeeper',
              quality: 'HD',
              url: 'https://filekeeper.example/repost-show-s1e1',
              sortOrder: 1
            }
          ]
        }
      ]
    };

    const messages = formatSeasonDetails(details, handles);

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain('Repost Show (2026)');
    expect(messages[0].text).toContain('📂 Season 1');
    expect(messages[0].text).toContain('🎞 Episode 1');
    expect(messages[0].text).toContain('📁 Filekeeper HD - https://filekeeper.example/repost-show-s1e1');
    expect(messages[0].text).not.toContain('📌 Original Post:');
    expect(messages[0].replyMarkup).toBeUndefined();
  });

  it('labels repeated season provider links under their episode headings', () => {
    const details: PublicSeasonDetails = {
      id: 101,
      showTitle: 'Repeated Hosts',
      showYear: 2026,
      seasonNumber: 1,
      episodes: [
        {
          episodeNumber: 1,
          providers: [
            {
              providerName: 'MixDrop',
              quality: 'HD',
              url: 'https://providers.example/repeated-s1e1',
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
              url: 'https://providers.example/repeated-s1e2',
              sortOrder: 1
            }
          ]
        }
      ]
    };

    const messages = formatSeasonDetails(details, handles);

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain('🎞 Episode 1\n🔗 Download Links:\n📁 MixDrop HD - https://providers.example/repeated-s1e1');
    expect(messages[0].text).toContain('🎞 Episode 2\n🔗 Download Links:\n📁 MixDrop HD - https://providers.example/repeated-s1e2');
    expect(messages[0].replyMarkup).toBeUndefined();
  });

  it('splits long season details while keeping episode provider links with the matching episode', () => {
    const details: PublicSeasonDetails = {
      id: 101,
      showTitle: 'Long Show',
      showYear: 2026,
      seasonNumber: 1,
      episodes: Array.from({ length: 260 }, (_, index) => ({
        episodeNumber: index + 1,
        providers: [
          {
            providerName: 'Host',
            quality: 'HD',
            url: `https://providers.example/long-show-s1e${index + 1}`,
            sortOrder: 1
          }
        ]
      }))
    };

    const messages = formatSeasonDetails(details, handles);

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.text.length <= MAX_FORMATTED_MESSAGE_LENGTH)).toBe(true);
    expect(messages.every((message) => message.replyMarkup === undefined)).toBe(true);
    expect(messages[0].text).toContain('🎞 Episode 1');
    expect(messages[0].text).toContain('📁 Host HD - https://providers.example/long-show-s1e1');
    const episode260Message = messages.find((message) => message.text.includes('🎞 Episode 260'));
    expect(episode260Message).toBeDefined();
    expect(episode260Message?.text).toContain('📁 Host HD - https://providers.example/long-show-s1e260');
  });

  it('splits season details when text length limits are reached', () => {
    const details: PublicSeasonDetails = {
      id: 101,
      showTitle: 'Text Limit Show',
      showYear: 2026,
      seasonNumber: 1,
      episodes: Array.from({ length: 120 }, (_, index) => ({
        episodeNumber: index + 1,
        providers: [
          {
            providerName: 'Host',
            quality: 'HD',
            url: `https://providers.example/text-limit-s1e${index + 1}-${'x'.repeat(80)}`,
            sortOrder: 1
          }
        ]
      }))
    };

    const messages = formatSeasonDetails(details, handles);

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.text.length <= MAX_FORMATTED_MESSAGE_LENGTH)).toBe(true);
    expect(messages.every((message) => message.replyMarkup === undefined)).toBe(true);
    expect(messages[0].text).toContain('📁 Host HD - https://providers.example/text-limit-s1e1');
    expect(messages.at(-1)?.text).toContain('📁 Host HD - https://providers.example/text-limit-s1e120');
  });

  it('splits one episode with many providers across safe messages', () => {
    const details: PublicSeasonDetails = {
      id: 101,
      showTitle: 'Big Episode Show',
      showYear: 2026,
      seasonNumber: 1,
      episodes: [
        {
          episodeNumber: 1,
          providers: Array.from({ length: 90 }, (_, index) => ({
            providerName: `Host${index + 1}`,
            quality: 'HD',
            url: `https://providers.example/big-episode-s1e1-${index + 1}-${'x'.repeat(80)}`,
            sortOrder: index + 1
          }))
        }
      ]
    };

    const messages = formatSeasonDetails(details, handles);

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.text.length).toBeLessThanOrEqual(MAX_FORMATTED_MESSAGE_LENGTH);
      expect(message.text).toContain('🎞 Episode 1');
      expect(message.replyMarkup).toBeUndefined();
    }
    expect(messages[0].text).toContain('📁 Host1 HD - https://providers.example/big-episode-s1e1-1');
    expect(messages.at(-1)?.text).toContain('📁 Host90 HD - https://providers.example/big-episode-s1e1-90');
    expect(
      messages
        .filter((message) => message.text.includes('https://providers.example/big-episode-s1e1-'))
        .every((message) => message.text.includes('🎞 Episode 1'))
    ).toBe(true);
  });
});
