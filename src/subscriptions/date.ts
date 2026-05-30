import { type SubscriptionPlanMonths, validateSubscriptionPlanMonths } from './plan.js';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateOnly(value: string) {
  if (!DATE_ONLY_PATTERN.test(value)) {
    throw new Error(`Invalid date-only value: ${value}`);
  }

  const parts = value.split('-').map(Number);
  const [year, month, day] = parts;

  if (parts.length !== 3 || year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid date-only value: ${value}`);
  }

  const utcTime = Date.UTC(year, month - 1, day);
  const date = new Date(utcTime);

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid date-only value: ${value}`);
  }

  return utcTime;
}

export function todayDateString(now: Date = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function validateDateOnly(value: string) {
  parseDateOnly(value);
}

export function addDateDays(dateOnly: string, days: number) {
  const date = new Date(parseDateOnly(dateOnly) + days * DAY_MS);
  return date.toISOString().slice(0, 10);
}

export function addDateMonths(dateOnly: string, months: SubscriptionPlanMonths) {
  validateSubscriptionPlanMonths(months);

  const date = new Date(parseDateOnly(dateOnly));
  const targetMonthIndex = date.getUTCMonth() + months;
  const targetYear = date.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12;
  const lastTargetMonthDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(date.getUTCDate(), lastTargetMonthDay);

  return new Date(Date.UTC(targetYear, targetMonth, targetDay)).toISOString().slice(0, 10);
}

export function calculateDaysRemaining(endDate: string, today: string) {
  return Math.max(0, Math.floor((parseDateOnly(endDate) - parseDateOnly(today)) / DAY_MS));
}

export function dateDifferenceDays(fromDate: string, toDate: string) {
  return Math.floor((parseDateOnly(toDate) - parseDateOnly(fromDate)) / DAY_MS);
}
