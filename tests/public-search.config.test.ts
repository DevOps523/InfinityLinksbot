import { describe, expect, it } from 'vitest';
import { loadPublicSearchConfig } from '../src/config.js';

describe('loadPublicSearchConfig', () => {
  const subscriptionEnv = {
    SUBSCRIPTION_BOT_TOKEN: 'subscription-token',
    SUBSCRIPTION_ADMIN_TOKEN: 'admin-token',
    GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet-id',
    GOOGLE_SERVICE_ACCOUNT_KEY_FILE: '/secure/google.json'
  };

  it('requires PUBLIC_BOT_TOKEN', () => {
    expect(() =>
      loadPublicSearchConfig({
        ...subscriptionEnv,
        PUBLIC_SEARCH_SYNC_TOKEN: 'sync-token',
        PUBLIC_SEARCH_STATUS_TOKEN: 'status-token'
      })
    ).toThrow(/PUBLIC_BOT_TOKEN is required/);
  });

  it('requires PUBLIC_SEARCH_SYNC_TOKEN', () => {
    expect(() =>
      loadPublicSearchConfig({
        ...subscriptionEnv,
        PUBLIC_BOT_TOKEN: 'bot-token',
        PUBLIC_SEARCH_STATUS_TOKEN: 'status-token'
      })
    ).toThrow(/PUBLIC_SEARCH_SYNC_TOKEN is required/);
  });

  it('requires PUBLIC_SEARCH_STATUS_TOKEN', () => {
    expect(() =>
      loadPublicSearchConfig({
        ...subscriptionEnv,
        PUBLIC_BOT_TOKEN: 'bot-token',
        PUBLIC_SEARCH_SYNC_TOKEN: 'sync-token'
      })
    ).toThrow(/PUBLIC_SEARCH_STATUS_TOKEN is required/);
  });

  it('rejects reusing the sync token as the status token after trimming', () => {
    expect(() =>
      loadPublicSearchConfig({
        ...subscriptionEnv,
        PUBLIC_BOT_TOKEN: 'bot-token',
        PUBLIC_SEARCH_SYNC_TOKEN: ' shared-token ',
        PUBLIC_SEARCH_STATUS_TOKEN: 'shared-token'
      })
    ).toThrow(/PUBLIC_SEARCH_STATUS_TOKEN must be different from PUBLIC_SEARCH_SYNC_TOKEN/);
  });

  it('rejects reusing the status token as the subscription admin token after trimming', () => {
    expect(() =>
      loadPublicSearchConfig({
        PUBLIC_BOT_TOKEN: 'bot-token',
        PUBLIC_SEARCH_SYNC_TOKEN: 'sync-token',
        PUBLIC_SEARCH_STATUS_TOKEN: ' shared-token ',
        SUBSCRIPTION_BOT_TOKEN: 'subscription-token',
        SUBSCRIPTION_ADMIN_TOKEN: 'shared-token',
        GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet-id',
        GOOGLE_SERVICE_ACCOUNT_KEY_FILE: '/secure/google.json'
      })
    ).toThrow(/SUBSCRIPTION_ADMIN_TOKEN must be different from PUBLIC_SEARCH_STATUS_TOKEN/);
  });

  it('returns required secrets and default public search settings', () => {
    expect(
      loadPublicSearchConfig({
        ...subscriptionEnv,
        PUBLIC_BOT_TOKEN: ' bot-token ',
        PUBLIC_SEARCH_SYNC_TOKEN: ' sync-token ',
        PUBLIC_SEARCH_STATUS_TOKEN: ' status-token '
      })
    ).toEqual({
      publicBotToken: 'bot-token',
      publicSearchSyncToken: 'sync-token',
      publicSearchStatusToken: 'status-token',
      publicSearchGroupHandle: '@infinitylinks69',
      publicSearchDatabasePath: './data/public-search.sqlite',
      publicSearchHost: '127.0.0.1',
      publicSearchPort: 3001,
      subscriptionBotToken: 'subscription-token',
      subscriptionGroupChatId: -1003963665033,
      subscriptionAlertThreadId: 46,
      subscriptionAdminContact: '@seinen_illuminatiks',
      subscriptionTrialSearchLimit: 5,
      subscriptionOverdueGraceDays: 1,
      subscriptionAdminToken: 'admin-token',
      googleSheetsSpreadsheetId: 'sheet-id',
      googleSheetsUsersRange: 'Users!A:H',
      googleSheetsHistoryRange: 'History!A:G',
      googleServiceAccountKeyFile: '/secure/google.json'
    });
  });

  it('falls back to defaults for blank optional values', () => {
    expect(
      loadPublicSearchConfig({
        ...subscriptionEnv,
        PUBLIC_BOT_TOKEN: 'bot-token',
        PUBLIC_SEARCH_SYNC_TOKEN: 'sync-token',
        PUBLIC_SEARCH_STATUS_TOKEN: 'status-token',
        PUBLIC_SEARCH_GROUP_HANDLE: '',
        PUBLIC_SEARCH_DATABASE_PATH: '   ',
        PUBLIC_SEARCH_HOST: ' ',
        PUBLIC_SEARCH_PORT: undefined
      })
    ).toMatchObject({
      publicSearchGroupHandle: '@infinitylinks69',
      publicSearchDatabasePath: './data/public-search.sqlite',
      publicSearchHost: '127.0.0.1',
      publicSearchPort: 3001
    });
  });

  it('accepts explicit optional values', () => {
    expect(
      loadPublicSearchConfig({
        ...subscriptionEnv,
        PUBLIC_BOT_TOKEN: 'bot-token',
        PUBLIC_SEARCH_SYNC_TOKEN: 'sync-token',
        PUBLIC_SEARCH_STATUS_TOKEN: 'status-token',
        PUBLIC_SEARCH_GROUP_HANDLE: '@customGroup',
        PUBLIC_SEARCH_DATABASE_PATH: './tmp/search.sqlite',
        PUBLIC_SEARCH_HOST: 'localhost',
        PUBLIC_SEARCH_PORT: '4321'
      })
    ).toMatchObject({
      publicSearchGroupHandle: '@customGroup',
      publicSearchDatabasePath: './tmp/search.sqlite',
      publicSearchHost: 'localhost',
      publicSearchPort: 4321
    });
  });

  it.each(['0.0.0.0', '192.168.1.10', 'example.com'])(
    'rejects externally reachable PUBLIC_SEARCH_HOST %s',
    (host) => {
      expect(() =>
        loadPublicSearchConfig({
          ...subscriptionEnv,
          PUBLIC_BOT_TOKEN: 'bot-token',
          PUBLIC_SEARCH_SYNC_TOKEN: 'sync-token',
          PUBLIC_SEARCH_STATUS_TOKEN: 'status-token',
          PUBLIC_SEARCH_HOST: host
        })
      ).toThrow(/PUBLIC_SEARCH_HOST must be a loopback host/);
    }
  );

  it('requires subscription bot and admin secrets', () => {
    expect(() =>
      loadPublicSearchConfig({
        PUBLIC_BOT_TOKEN: 'bot-token',
        PUBLIC_SEARCH_SYNC_TOKEN: 'sync-token',
        PUBLIC_SEARCH_STATUS_TOKEN: 'status-token',
        SUBSCRIPTION_ADMIN_TOKEN: 'admin-token'
      })
    ).toThrow(/SUBSCRIPTION_BOT_TOKEN is required/);

    expect(() =>
      loadPublicSearchConfig({
        PUBLIC_BOT_TOKEN: 'bot-token',
        PUBLIC_SEARCH_SYNC_TOKEN: 'sync-token',
        PUBLIC_SEARCH_STATUS_TOKEN: 'status-token',
        SUBSCRIPTION_BOT_TOKEN: 'subscription-token'
      })
    ).toThrow(/SUBSCRIPTION_ADMIN_TOKEN is required/);
  });

  it('requires Google Sheets spreadsheet and service account settings', () => {
    expect(() =>
      loadPublicSearchConfig({
        PUBLIC_BOT_TOKEN: 'bot-token',
        PUBLIC_SEARCH_SYNC_TOKEN: 'sync-token',
        PUBLIC_SEARCH_STATUS_TOKEN: 'status-token',
        SUBSCRIPTION_BOT_TOKEN: 'subscription-token',
        SUBSCRIPTION_ADMIN_TOKEN: 'admin-token',
        GOOGLE_SERVICE_ACCOUNT_KEY_FILE: '/secure/google.json'
      })
    ).toThrow(/GOOGLE_SHEETS_SPREADSHEET_ID is required/);

    expect(() =>
      loadPublicSearchConfig({
        PUBLIC_BOT_TOKEN: 'bot-token',
        PUBLIC_SEARCH_SYNC_TOKEN: 'sync-token',
        PUBLIC_SEARCH_STATUS_TOKEN: 'status-token',
        SUBSCRIPTION_BOT_TOKEN: 'subscription-token',
        SUBSCRIPTION_ADMIN_TOKEN: 'admin-token',
        GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet-id'
      })
    ).toThrow(/GOOGLE_SERVICE_ACCOUNT_KEY_FILE is required/);
  });

  it('rejects reusing the sync token as the subscription admin token after trimming', () => {
    expect(() =>
      loadPublicSearchConfig({
        PUBLIC_BOT_TOKEN: 'bot-token',
        PUBLIC_SEARCH_SYNC_TOKEN: ' shared-token ',
        PUBLIC_SEARCH_STATUS_TOKEN: 'status-token',
        SUBSCRIPTION_BOT_TOKEN: 'subscription-token',
        SUBSCRIPTION_ADMIN_TOKEN: 'shared-token',
        GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet-id',
        GOOGLE_SERVICE_ACCOUNT_KEY_FILE: '/secure/google.json'
      })
    ).toThrow(/SUBSCRIPTION_ADMIN_TOKEN must be different from PUBLIC_SEARCH_SYNC_TOKEN/);
  });

  it('returns subscription defaults and explicit sheet settings', () => {
    expect(
      loadPublicSearchConfig({
        PUBLIC_BOT_TOKEN: 'bot-token',
        PUBLIC_SEARCH_SYNC_TOKEN: 'sync-token',
        PUBLIC_SEARCH_STATUS_TOKEN: 'status-token',
        SUBSCRIPTION_BOT_TOKEN: 'subscription-token',
        SUBSCRIPTION_ADMIN_TOKEN: 'admin-token',
        GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet-id',
        GOOGLE_SERVICE_ACCOUNT_KEY_FILE: '/secure/google.json'
      })
    ).toMatchObject({
      subscriptionBotToken: 'subscription-token',
      subscriptionGroupChatId: -1003963665033,
      subscriptionAlertThreadId: 46,
      subscriptionAdminContact: '@seinen_illuminatiks',
      subscriptionTrialSearchLimit: 5,
      subscriptionOverdueGraceDays: 1,
      subscriptionAdminToken: 'admin-token',
      googleSheetsSpreadsheetId: 'sheet-id',
      googleSheetsUsersRange: 'Users!A:H',
      googleSheetsHistoryRange: 'History!A:G',
      googleServiceAccountKeyFile: '/secure/google.json'
    });
  });

  it('accepts explicit subscription and Google Sheets optional values', () => {
    expect(
      loadPublicSearchConfig({
        PUBLIC_BOT_TOKEN: 'bot-token',
        PUBLIC_SEARCH_SYNC_TOKEN: 'sync-token',
        PUBLIC_SEARCH_STATUS_TOKEN: 'status-token',
        SUBSCRIPTION_BOT_TOKEN: 'subscription-token',
        SUBSCRIPTION_GROUP_CHAT_ID: '-100123',
        SUBSCRIPTION_ALERT_THREAD_ID: '47',
        SUBSCRIPTION_ADMIN_CONTACT: ' @admin_contact ',
        SUBSCRIPTION_TRIAL_SEARCH_LIMIT: '7',
        SUBSCRIPTION_OVERDUE_GRACE_DAYS: '2',
        SUBSCRIPTION_ADMIN_TOKEN: 'admin-token',
        GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet-id',
        GOOGLE_SHEETS_USERS_RANGE: ' Members!A:H ',
        GOOGLE_SHEETS_HISTORY_RANGE: ' Payments!A:G ',
        GOOGLE_SERVICE_ACCOUNT_KEY_FILE: '/secure/google.json'
      })
    ).toMatchObject({
      subscriptionGroupChatId: -100123,
      subscriptionAlertThreadId: 47,
      subscriptionAdminContact: '@admin_contact',
      subscriptionTrialSearchLimit: 7,
      subscriptionOverdueGraceDays: 2,
      googleSheetsUsersRange: 'Members!A:H',
      googleSheetsHistoryRange: 'Payments!A:G'
    });
  });

  it('ignores obsolete SUBSCRIPTION_PERIOD_DAYS env values', () => {
    expect(
      loadPublicSearchConfig({
        ...subscriptionEnv,
        PUBLIC_BOT_TOKEN: 'bot-token',
        PUBLIC_SEARCH_SYNC_TOKEN: 'sync-token',
        PUBLIC_SEARCH_STATUS_TOKEN: 'status-token',
        SUBSCRIPTION_PERIOD_DAYS: '365'
      })
    ).not.toHaveProperty('subscriptionPeriodDays');
  });

  it.each(['0', '-1', '1.5', 'not-a-number'])(
    'rejects invalid SUBSCRIPTION_TRIAL_SEARCH_LIMIT %s',
    (limit) => {
      expect(() =>
        loadPublicSearchConfig({
          ...subscriptionEnv,
          PUBLIC_BOT_TOKEN: 'bot-token',
          PUBLIC_SEARCH_SYNC_TOKEN: 'sync-token',
          PUBLIC_SEARCH_STATUS_TOKEN: 'status-token',
          SUBSCRIPTION_TRIAL_SEARCH_LIMIT: limit
        })
      ).toThrow();
    }
  );
});
