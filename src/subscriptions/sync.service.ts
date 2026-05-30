import type { PublicSearchDatabase } from '../db/database.js';
import type { GoogleSheetsClient } from './google-sheets.client.js';
import {
  applySubscriptionStartDate,
  getSubscriptionUser,
  listActiveSubscriptionRows,
  listKickedUsersPendingHistoryExport,
  markSubscriptionUsersHistoryExported,
  recalculateSubscriptions,
  type SubscriptionUser
} from './repository.js';
import { todayDateString } from './date.js';
import { parseUsersSheetRows, toHistorySheetRow, toUsersSheetRows } from './sheet.mapper.js';
import { DEFAULT_SUBSCRIPTION_PLAN_MONTHS } from './plan.js';

type SyncSheetsClient = Pick<GoogleSheetsClient, 'readRows' | 'replaceRows' | 'appendRows'>;

export type SyncSubscriptionsFromSheetOptions = {
  usersRange: string;
  historyRange: string;
  now: Date;
};

export type SyncSubscriptionsFromSheetResult = {
  updatedUsers: number;
  skippedUnknownUsers: number;
  paidUsers: SubscriptionUser[];
};

export async function syncSubscriptionsFromSheet(
  db: PublicSearchDatabase,
  sheets: SyncSheetsClient,
  options: SyncSubscriptionsFromSheetOptions
): Promise<SyncSubscriptionsFromSheetResult> {
  const rows = await sheets.readRows(options.usersRange);
  const parsedRows = parseUsersSheetRows(rows);
  recalculateSubscriptions(db, todayDateString(options.now));
  let updatedUsers = 0;
  let skippedUnknownUsers = 0;
  const paidUsers: SubscriptionUser[] = [];

  for (const row of parsedRows) {
    if (!row.startDate) {
      continue;
    }

    const planMonths = row.planMonths ?? DEFAULT_SUBSCRIPTION_PLAN_MONTHS;
    const current = getSubscriptionUser(db, row.telegramUserId);
    if (!current) {
      skippedUnknownUsers += 1;
      continue;
    }

    if (current.subscriptionStartDate === row.startDate && current.subscriptionPlanMonths === planMonths) {
      if (current.removedFromGroup) {
        await appendPendingKickedHistory(db, sheets, options, current);
        const paidUser = applySubscriptionStartDate(
          db,
          row.telegramUserId,
          row.startDate,
          planMonths,
          options.now
        );
        if (needsUnban(paidUser)) {
          paidUsers.push(paidUser);
        }
      }
      continue;
    }

    await appendPendingKickedHistory(db, sheets, options, current);
    const paidUser = applySubscriptionStartDate(db, row.telegramUserId, row.startDate, planMonths, options.now);
    if (needsUnban(paidUser)) {
      paidUsers.push(paidUser);
    }
    updatedUsers += 1;
  }

  await sheets.replaceRows(options.usersRange, toUsersSheetRows(listActiveSubscriptionRows(db)));

  return { updatedUsers, skippedUnknownUsers, paidUsers };
}

function needsUnban(user: SubscriptionUser) {
  return user.removedFromGroup && (user.status === 'Subscribe' || user.status === 'Needs Attention');
}

async function appendPendingKickedHistory(
  db: PublicSearchDatabase,
  sheets: Pick<GoogleSheetsClient, 'appendRows'>,
  options: Pick<SyncSubscriptionsFromSheetOptions, 'historyRange'>,
  user: SubscriptionUser
) {
  const pendingUsers = listKickedUsersPendingHistoryExport(db, [user.telegramUserId]);

  if (pendingUsers.length === 0) {
    return;
  }

  await sheets.appendRows(options.historyRange, pendingUsers.map(toHistorySheetRow));
  markSubscriptionUsersHistoryExported(
    db,
    pendingUsers.map((pendingUser) => pendingUser.telegramUserId),
    new Date()
  );
}

export async function moveKickedUsersToHistory(
  db: PublicSearchDatabase,
  sheets: Pick<GoogleSheetsClient, 'replaceRows' | 'appendRows'>,
  options: {
    usersRange: string;
    historyRange: string;
    users: SubscriptionUser[];
  }
) {
  const pendingUsers = listKickedUsersPendingHistoryExport(
    db,
    options.users.map((user) => user.telegramUserId)
  );

  if (pendingUsers.length > 0) {
    await sheets.appendRows(options.historyRange, pendingUsers.map(toHistorySheetRow));
    markSubscriptionUsersHistoryExported(
      db,
      pendingUsers.map((user) => user.telegramUserId),
      new Date()
    );
  }

  await sheets.replaceRows(options.usersRange, toUsersSheetRows(listActiveSubscriptionRows(db)));
  return { movedUsers: pendingUsers.length };
}
