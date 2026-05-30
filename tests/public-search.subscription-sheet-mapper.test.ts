import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HISTORY_HEADER,
  USERS_HEADER,
  parseUsersSheetRows,
  toHistorySheetRow,
  toUsersSheetRows
} from '../src/subscriptions/sheet.mapper.js';
import { createGoogleSheetsClient } from '../src/subscriptions/google-sheets.client.js';

const googleApiMock = vi.hoisted(() => {
  const get = vi.fn();
  const clear = vi.fn();
  const update = vi.fn();
  const append = vi.fn();
  const sheets = vi.fn(() => ({
    spreadsheets: {
      values: {
        clear,
        get,
        update,
        append
      }
    }
  }));
  const GoogleAuth = vi.fn();

  return { append, clear, get, GoogleAuth, sheets, update };
});

vi.mock('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: googleApiMock.GoogleAuth
    },
    sheets: googleApiMock.sheets
  }
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('subscription sheet mapper', () => {
  it('defines the Users sheet header with the Plan column', () => {
    expect(USERS_HEADER).toEqual([
      'User ID',
      'Username',
      'Start Date',
      'Plan',
      'End Date',
      'Days Remaining',
      'Status',
      'Last Updated'
    ]);
  });

  it('parses user rows by permanent user id', () => {
    expect(
      parseUsersSheetRows([
        USERS_HEADER,
        ['42', '@paid_user', '2026-05-26', '3 months', '2026-08-26', '92', 'Subscribe', '2026-05-26T00:00:00.000Z'],
        ['', '', '', '', '', '', '', '']
      ])
    ).toEqual([
      {
        telegramUserId: 42,
        username: 'paid_user',
        startDate: '2026-05-26',
        planMonths: 3,
        endDate: '2026-08-26',
        daysRemaining: 92,
        status: 'Subscribe',
        lastUpdated: '2026-05-26T00:00:00.000Z'
      }
    ]);
  });

  it('normalizes Google-formatted sheet dates', () => {
    expect(
      parseUsersSheetRows([
        USERS_HEADER,
        ['42', '@paid_user', '5/27/2026', '1 Month', '6/27/2026', '31', 'Subscribe', '2026-05-26T00:00:00.000Z']
      ])
    ).toEqual([
      {
        telegramUserId: 42,
        username: 'paid_user',
        startDate: '2026-05-27',
        planMonths: 1,
        endDate: '2026-06-27',
        daysRemaining: 31,
        status: 'Subscribe',
        lastUpdated: '2026-05-26T00:00:00.000Z'
      }
    ]);
  });

  it('requires the expected Users sheet header', () => {
    expect(() => parseUsersSheetRows([])).toThrow(/Users sheet header mismatch/);
    expect(() =>
      parseUsersSheetRows([
        ['Username', 'User ID', 'Start Date', 'Plan', 'End Date', 'Days Remaining', 'Status', 'Last Updated'],
        ['42', '@paid_user', '2026-05-26', '1 Month', '2026-06-26', '31', 'Subscribe', '2026-05-26T00:00:00.000Z']
      ])
    ).toThrow(/Users sheet header mismatch: expected User ID \| Username \| Start Date \| Plan \| End Date \| Days Remaining \| Status \| Last Updated/);
  });

  it('ignores blank trailing rows but rejects nonblank invalid user ids', () => {
    expect(
      parseUsersSheetRows([
        USERS_HEADER,
        ['42', '@paid_user', '2026-05-26', '', '', '', 'Subscribe', '2026-05-26T00:00:00.000Z'],
        [],
        [' ', ' ', '', '', '', '', '', '']
      ])
    ).toEqual([
      {
        telegramUserId: 42,
        username: 'paid_user',
        startDate: '2026-05-26',
        planMonths: undefined,
        endDate: undefined,
        daysRemaining: undefined,
        status: 'Subscribe',
        lastUpdated: '2026-05-26T00:00:00.000Z'
      }
    ]);

    for (const invalidUserId of ['abc', '42.5', '0', '-1', '']) {
      expect(() =>
        parseUsersSheetRows([USERS_HEADER, [invalidUserId, '@paid_user', '2026-05-26', '', '', '', 'Subscribe', '']])
      ).toThrow(/Invalid User ID in Users sheet row 2/);
    }
  });

  it('allows empty start dates for trial and unpaid users', () => {
    expect(
      parseUsersSheetRows([
        USERS_HEADER,
        ['42', 'trial_user', '', '', '', '', 'Trial', '2026-05-26T00:00:00.000Z'],
        ['43', '@unpaid_user', '', '', '', '', 'unpaid', '']
      ])
    ).toEqual([
      {
        telegramUserId: 42,
        username: 'trial_user',
        startDate: undefined,
        planMonths: undefined,
        endDate: undefined,
        daysRemaining: undefined,
        status: 'Trial',
        lastUpdated: '2026-05-26T00:00:00.000Z'
      },
      {
        telegramUserId: 43,
        username: 'unpaid_user',
        startDate: undefined,
        planMonths: undefined,
        endDate: undefined,
        daysRemaining: undefined,
        status: 'Unpaid',
        lastUpdated: undefined
      }
    ]);
  });

  it('normalizes subscription plan values from the Plan column', () => {
    expect(
      parseUsersSheetRows([
        USERS_HEADER,
        ['42', '@one_month', '2026-05-26', 1, '2026-06-26', '31', 'Subscribe', '2026-05-26T00:00:00.000Z'],
        ['43', '@three_months', '2026-05-26', 'three months', '2026-08-26', '92', 'Subscribe', '2026-05-26T00:00:00.000Z'],
        ['44', '@six_months', '2026-05-26', '  6 MONTHS  ', '2026-11-26', '184', 'Subscribe', '2026-05-26T00:00:00.000Z']
      ])
    ).toEqual([
      {
        telegramUserId: 42,
        username: 'one_month',
        startDate: '2026-05-26',
        planMonths: 1,
        endDate: '2026-06-26',
        daysRemaining: 31,
        status: 'Subscribe',
        lastUpdated: '2026-05-26T00:00:00.000Z'
      },
      {
        telegramUserId: 43,
        username: 'three_months',
        startDate: '2026-05-26',
        planMonths: 3,
        endDate: '2026-08-26',
        daysRemaining: 92,
        status: 'Subscribe',
        lastUpdated: '2026-05-26T00:00:00.000Z'
      },
      {
        telegramUserId: 44,
        username: 'six_months',
        startDate: '2026-05-26',
        planMonths: 6,
        endDate: '2026-11-26',
        daysRemaining: 184,
        status: 'Subscribe',
        lastUpdated: '2026-05-26T00:00:00.000Z'
      }
    ]);
  });

  it('rejects invalid subscription plan values with row context', () => {
    expect(() =>
      parseUsersSheetRows([
        USERS_HEADER,
        ['42', '@paid_user', '2026-05-26', '2 Months', '2026-07-26', '61', 'Subscribe', '2026-05-26T00:00:00.000Z']
      ])
    ).toThrow('Invalid Plan in Users sheet row 2: 2 Months. Expected 1 Month, 3 Months, or 6 Months');
  });

  it('rejects invalid dates, days remaining, and statuses', () => {
    expect(() => parseUsersSheetRows([USERS_HEADER, ['42', '@paid_user', '2026-02-31', '', '', '', '', '']])).toThrow(
      /Invalid Start Date in Users sheet row 2/
    );
    expect(() => parseUsersSheetRows([USERS_HEADER, ['42', '@paid_user', '2\/31\/2026', '', '', '', '', '']])).toThrow(
      /Invalid Start Date in Users sheet row 2/
    );
    expect(() => parseUsersSheetRows([USERS_HEADER, ['42', '@paid_user', '', '', '', '-1', '', '']])).toThrow(
      /Invalid Days Remaining/
    );
    expect(() => parseUsersSheetRows([USERS_HEADER, ['42', '@paid_user', '', '', '', '', 'Paused', '']])).toThrow(
      /Invalid subscription status/
    );
  });

  it('formats active and history rows', () => {
    expect(
      toUsersSheetRows([
        {
          telegramUserId: 42,
          username: 'paid_user',
          subscriptionStartDate: '2026-05-26',
          subscriptionPlanMonths: 1,
          subscriptionEndDate: '2026-06-26',
          daysRemaining: 31,
          status: 'Subscribe',
          removedFromGroup: false,
          createdAt: '2026-05-26T00:00:00.000Z',
          updatedAt: '2026-05-26T00:00:00.000Z'
        }
      ])
    ).toEqual([
      USERS_HEADER,
      ['42', '@paid_user', '2026-05-26', '1 Month', '2026-06-26', '31', 'Subscribe', '2026-05-26T00:00:00.000Z']
    ]);

    expect(
      toHistorySheetRow({
        telegramUserId: 42,
        username: 'paid_user',
        subscriptionStartDate: '2026-05-26',
        subscriptionPlanMonths: 1,
        subscriptionEndDate: '2026-06-26',
        status: 'Kicked',
        kickedAt: '2026-06-27T00:00:00.000Z',
        removedFromGroup: true,
        createdAt: '2026-05-26T00:00:00.000Z',
        updatedAt: '2026-06-27T00:00:00.000Z'
      })
    ).toEqual(['42', '@paid_user', 'Kicked', '2026-06-27T00:00:00.000Z', '2026-05-26', '2026-06-26', 'Overdue subscription removed']);

    expect(HISTORY_HEADER).toEqual(['User ID', 'Username', 'Last Status', 'Kicked At', 'Last Start Date', 'Last End Date', 'Notes']);
  });

  it('writes plan labels only for paid user rows', () => {
    expect(
      toUsersSheetRows([
        {
          telegramUserId: 42,
          username: 'paid_user',
          subscriptionStartDate: '2026-05-26',
          subscriptionPlanMonths: 3,
          subscriptionEndDate: '2026-08-26',
          daysRemaining: 92,
          status: 'Subscribe',
          removedFromGroup: false,
          createdAt: '2026-05-26T00:00:00.000Z',
          updatedAt: '2026-05-26T00:00:00.000Z'
        },
        {
          telegramUserId: 43,
          username: 'trial_user',
          subscriptionStartDate: undefined,
          subscriptionPlanMonths: 1,
          subscriptionEndDate: undefined,
          daysRemaining: undefined,
          status: 'Trial',
          removedFromGroup: false,
          createdAt: '2026-05-26T00:00:00.000Z',
          updatedAt: '2026-05-26T00:00:00.000Z'
        }
      ])
    ).toEqual([
      USERS_HEADER,
      ['42', '@paid_user', '2026-05-26', '3 Months', '2026-08-26', '92', 'Subscribe', '2026-05-26T00:00:00.000Z'],
      ['43', '@trial_user', '', '', '', '', 'Trial', '2026-05-26T00:00:00.000Z']
    ]);
  });
});

describe('Google Sheets subscription client', () => {
  it('sets up auth lazily and wires values requests', async () => {
    googleApiMock.get.mockResolvedValueOnce({
      data: {
        values: [USERS_HEADER, ['42', '@paid_user', '2026-05-26', '1 Month', '', '', 'Subscribe', '2026-05-26T00:00:00.000Z']]
      }
    });

    const client = createGoogleSheetsClient({
      spreadsheetId: 'sheet-id',
      serviceAccountKeyFile: '/secure/google.json',
      usersRange: 'Users!A:H',
      historyRange: 'History!A:G'
    });

    expect(googleApiMock.GoogleAuth).not.toHaveBeenCalled();
    await expect(client.readUsers()).resolves.toEqual([
      {
        telegramUserId: 42,
        username: 'paid_user',
        startDate: '2026-05-26',
        planMonths: 1,
        endDate: undefined,
        daysRemaining: undefined,
        status: 'Subscribe',
        lastUpdated: '2026-05-26T00:00:00.000Z'
      }
    ]);

    expect(googleApiMock.GoogleAuth).toHaveBeenCalledWith({
      keyFile: '/secure/google.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    expect(googleApiMock.sheets).toHaveBeenCalledWith({
      version: 'v4',
      auth: expect.any(googleApiMock.GoogleAuth)
    });
    expect(googleApiMock.get).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      range: 'Users!A:H'
    });
  });

  it('replaces users and appends history with raw values', async () => {
    googleApiMock.clear.mockResolvedValueOnce({ data: {} });
    googleApiMock.update.mockResolvedValueOnce({ data: {} });
    googleApiMock.append.mockResolvedValueOnce({ data: {} });

    const client = createGoogleSheetsClient({
      spreadsheetId: 'sheet-id',
      serviceAccountKeyFile: '/secure/google.json',
      usersRange: 'Users!A:H',
      historyRange: 'History!A:G'
    });
    const user = {
      telegramUserId: 42,
      username: 'paid_user',
      subscriptionStartDate: '2026-05-26',
      subscriptionPlanMonths: 1,
      subscriptionEndDate: '2026-06-26',
      daysRemaining: 31,
      status: 'Kicked' as const,
      kickedAt: '2026-06-27T00:00:00.000Z',
      removedFromGroup: true,
      createdAt: '2026-05-26T00:00:00.000Z',
      updatedAt: '2026-06-27T00:00:00.000Z'
    };

    await client.writeUsers([user]);
    await client.appendHistory([user]);
    await client.appendHistory([]);

    expect(googleApiMock.clear).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      range: 'Users!A:H'
    });
    expect(googleApiMock.update).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      range: 'Users!A:H',
      valueInputOption: 'RAW',
      requestBody: {
        values: [
          USERS_HEADER,
          ['42', '@paid_user', '2026-05-26', '1 Month', '2026-06-26', '31', 'Kicked', '2026-06-27T00:00:00.000Z']
        ]
      }
    });
    expect(googleApiMock.clear.mock.invocationCallOrder[0]).toBeLessThan(googleApiMock.update.mock.invocationCallOrder[0] ?? 0);
    expect(googleApiMock.append).toHaveBeenCalledTimes(1);
    expect(googleApiMock.append).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-id',
      range: 'History!A:G',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [['42', '@paid_user', 'Kicked', '2026-06-27T00:00:00.000Z', '2026-05-26', '2026-06-26', 'Overdue subscription removed']]
      }
    });
  });
});
