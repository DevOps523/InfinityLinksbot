import { google, type sheets_v4 } from 'googleapis';

import type { SubscriptionUser } from './repository.js';
import { parseUsersSheetRows, toHistorySheetRow, toUsersSheetRows, type ParsedUsersSheetRow } from './sheet.mapper.js';

export type GoogleSheetsClientConfig = {
  spreadsheetId: string;
  serviceAccountKeyFile: string;
  usersRange: string;
  historyRange: string;
};

export type GoogleSheetsClient = {
  readRows: (range: string) => Promise<unknown[][]>;
  replaceRows: (range: string, rows: unknown[][]) => Promise<void>;
  appendRows: (range: string, rows: unknown[][]) => Promise<void>;
  readUsers: () => Promise<ParsedUsersSheetRow[]>;
  writeUsers: (users: SubscriptionUser[]) => Promise<void>;
  appendHistory: (users: SubscriptionUser[]) => Promise<void>;
};

export function createGoogleSheetsClient(config: GoogleSheetsClientConfig): GoogleSheetsClient {
  let sheets: sheets_v4.Sheets | undefined;

  function getSheets() {
    sheets ??= google.sheets({
      version: 'v4',
      auth: new google.auth.GoogleAuth({
        keyFile: config.serviceAccountKeyFile,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      })
    });

    return sheets;
  }

  async function readRows(range: string) {
    const response = await getSheets().spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range
    });

    return response.data.values ?? [];
  }

  async function replaceRows(range: string, rows: unknown[][]) {
    const sheetsClient = getSheets();

    await sheetsClient.spreadsheets.values.clear({
      spreadsheetId: config.spreadsheetId,
      range
    });

    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: {
        values: rows
      }
    });
  }

  async function appendRows(range: string, rows: unknown[][]) {
    if (rows.length === 0) {
      return;
    }

    await getSheets().spreadsheets.values.append({
      spreadsheetId: config.spreadsheetId,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: rows
      }
    });
  }

  return {
    readRows,
    replaceRows,
    appendRows,
    async readUsers() {
      return parseUsersSheetRows(await readRows(config.usersRange));
    },
    async writeUsers(users: SubscriptionUser[]) {
      await replaceRows(config.usersRange, toUsersSheetRows(users));
    },
    async appendHistory(users: SubscriptionUser[]) {
      await appendRows(config.historyRange, users.map(toHistorySheetRow));
    }
  };
}
