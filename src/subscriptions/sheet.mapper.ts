import { validateDateOnly } from './date.js';
import {
  normalizeSubscriptionPlan,
  subscriptionPlanLabel,
  type SubscriptionPlanMonths
} from './plan.js';
import type { SubscriptionStatus, SubscriptionUser } from './repository.js';

export const USERS_HEADER = ['User ID', 'Username', 'Start Date', 'Plan', 'End Date', 'Days Remaining', 'Status', 'Last Updated'];
export const HISTORY_HEADER = ['User ID', 'Username', 'Last Status', 'Kicked At', 'Last Start Date', 'Last End Date', 'Notes'];

const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'Trial',
  'Subscribe',
  'Needs Attention',
  'Unpaid',
  'Kicked'
];

export type ParsedUsersSheetRow = {
  telegramUserId: number;
  username?: string | undefined;
  startDate?: string | undefined;
  planMonths?: SubscriptionPlanMonths | undefined;
  endDate?: string | undefined;
  daysRemaining?: number | undefined;
  status?: SubscriptionStatus | undefined;
  lastUpdated?: string | undefined;
};

type SheetCell = unknown;

export class SheetValidationError extends Error {
  statusCode = 400;
  expose = true;

  constructor(message: string) {
    super(message);
    this.name = 'SheetValidationError';
  }
}

function normalizeString(value: SheetCell) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }

  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeUsername(value: SheetCell) {
  const trimmed = normalizeString(value);
  return trimmed ? trimmed.replace(/^@+/, '') : undefined;
}

function toIsoDate(year: number, month: number, day: number, original: string) {
  const utcTime = Date.UTC(year, month - 1, day);
  const date = new Date(utcTime);

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new SheetValidationError(`Invalid date value: ${original}`);
  }

  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0')
  ].join('-');
}

function normalizeDateOnly(value: SheetCell, label: string, rowNumber: number) {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return undefined;
  }

  try {
    validateDateOnly(trimmed);
    return trimmed;
  } catch {
    const slashDate = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!slashDate) {
      throw new SheetValidationError(`Invalid ${label} in Users sheet row ${rowNumber}: ${trimmed}`);
    }

    const [, month, day, year] = slashDate;
    try {
      return toIsoDate(Number(year), Number(month), Number(day), trimmed);
    } catch {
      throw new SheetValidationError(`Invalid ${label} in Users sheet row ${rowNumber}: ${trimmed}`);
    }
  }
}

function normalizeDaysRemaining(value: SheetCell) {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return undefined;
  }

  const daysRemaining = Number(trimmed);
  if (!Number.isInteger(daysRemaining) || daysRemaining < 0) {
    throw new SheetValidationError(`Invalid Days Remaining value: ${trimmed}`);
  }

  return daysRemaining;
}

function normalizePlan(value: SheetCell, rowNumber: number) {
  const raw = normalizeString(value);
  if (!raw) {
    return undefined;
  }

  try {
    return normalizeSubscriptionPlan(raw);
  } catch {
    throw new SheetValidationError(
      `Invalid Plan in Users sheet row ${rowNumber}: ${raw}. Expected 1 Month, 3 Months, or 6 Months`
    );
  }
}

function normalizeStatus(value: SheetCell) {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return undefined;
  }

  const status = SUBSCRIPTION_STATUSES.find((candidate) => candidate.toLowerCase() === trimmed.toLowerCase());
  if (!status) {
    throw new SheetValidationError(`Invalid subscription status: ${trimmed}`);
  }

  return status;
}

function normalizeLastUpdated(value: SheetCell) {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return undefined;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    throw new SheetValidationError(`Invalid Last Updated value: ${trimmed}`);
  }

  return trimmed;
}

function usernameCell(user: SubscriptionUser) {
  return user.username ? `@${user.username.replace(/^@+/, '')}` : '';
}

function isBlankRow(row: SheetCell[]) {
  return row.every((cell) => normalizeString(cell) === undefined);
}

function validateUsersHeader(rows: SheetCell[][]) {
  const header = rows[0];
  if (!header) {
    throw new SheetValidationError(`Users sheet header mismatch: expected ${USERS_HEADER.join(' | ')}`);
  }

  const actualHeader = header.slice(0, USERS_HEADER.length).map((cell) => normalizeString(cell) ?? '');
  const matches = USERS_HEADER.every((expected, index) => actualHeader[index] === expected);
  if (!matches) {
    throw new SheetValidationError(`Users sheet header mismatch: expected ${USERS_HEADER.join(' | ')}, received ${actualHeader.join(' | ')}`);
  }
}

function normalizeTelegramUserId(value: SheetCell, rowNumber: number) {
  const trimmed = normalizeString(value);
  const numericId = typeof value === 'number' ? value : trimmed && /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;

  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    throw new SheetValidationError(`Invalid User ID in Users sheet row ${rowNumber}: ${trimmed ?? ''}`);
  }

  return numericId;
}

export function parseUsersSheetRows(rows: SheetCell[][]): ParsedUsersSheetRow[] {
  validateUsersHeader(rows);

  return rows.slice(1).flatMap((row, index) => {
    if (isBlankRow(row)) {
      return [];
    }

    const telegramUserId = normalizeTelegramUserId(row[0], index + 2);

    return [
      {
        telegramUserId,
        username: normalizeUsername(row[1]),
        startDate: normalizeDateOnly(row[2], 'Start Date', index + 2),
        planMonths: normalizePlan(row[3], index + 2),
        endDate: normalizeDateOnly(row[4], 'End Date', index + 2),
        daysRemaining: normalizeDaysRemaining(row[5]),
        status: normalizeStatus(row[6]),
        lastUpdated: normalizeLastUpdated(row[7])
      }
    ];
  });
}

export function toUsersSheetRows(users: SubscriptionUser[]) {
  return [
    USERS_HEADER,
    ...users.map((user) => [
      String(user.telegramUserId),
      usernameCell(user),
      user.subscriptionStartDate ?? '',
      user.subscriptionStartDate ? subscriptionPlanLabel(user.subscriptionPlanMonths) : '',
      user.subscriptionEndDate ?? '',
      user.daysRemaining === undefined ? '' : String(user.daysRemaining),
      user.status,
      user.updatedAt
    ])
  ];
}

export function toHistorySheetRow(user: SubscriptionUser) {
  return [
    String(user.telegramUserId),
    usernameCell(user),
    user.status,
    user.kickedAt ?? '',
    user.subscriptionStartDate ?? '',
    user.subscriptionEndDate ?? '',
    'Overdue subscription removed'
  ];
}
