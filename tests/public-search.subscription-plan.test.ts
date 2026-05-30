import { describe, expect, it } from 'vitest';
import { addDateMonths } from '../src/subscriptions/date.js';
import {
  DEFAULT_SUBSCRIPTION_PLAN_MONTHS,
  normalizeSubscriptionPlan,
  subscriptionPlanLabel,
  validateSubscriptionPlanMonths
} from '../src/subscriptions/plan.js';

describe('subscription plan helpers', () => {
  it('uses a one-month default subscription plan', () => {
    expect(DEFAULT_SUBSCRIPTION_PLAN_MONTHS).toBe(1);
  });

  it.each([
    ['1 Month', 1],
    ['1 month', 1],
    ['1 months', 1],
    ['1', 1],
    ['one month', 1],
    ['3 Months', 3],
    ['3 month', 3],
    ['three months', 3],
    ['3', 3],
    ['6 Months', 6],
    ['6 month', 6],
    ['six months', 6],
    ['6', 6]
  ])('normalizes %s to %i months', (value, expected) => {
    expect(normalizeSubscriptionPlan(value)).toBe(expected);
  });

  it.each(['', ' ', undefined, null])('treats blank plan value %s as unset', (value) => {
    expect(normalizeSubscriptionPlan(value)).toBeUndefined();
  });

  it.each(['2 Months', 'lifetime'])('rejects unsupported plan value %s', (value) => {
    expect(() => normalizeSubscriptionPlan(value)).toThrow(
      `Invalid Plan: ${value}. Expected 1 Month, 3 Months, or 6 Months`
    );
  });

  it('validates plan month counts', () => {
    expect(() => validateSubscriptionPlanMonths(1)).not.toThrow();
    expect(() => validateSubscriptionPlanMonths(3)).not.toThrow();
    expect(() => validateSubscriptionPlanMonths(6)).not.toThrow();
    expect(() => validateSubscriptionPlanMonths(2)).toThrow(/Subscription plan months must be 1, 3, or 6/);
  });

  it.each([
    [1, '1 Month'],
    [3, '3 Months'],
    [6, '6 Months']
  ] as const)('labels %i-month plans as %s', (months, expected) => {
    expect(subscriptionPlanLabel(months)).toBe(expected);
  });
});

describe('subscription month date math', () => {
  it.each([
    [1, '2026-05-27', '2026-06-27'],
    [3, '2026-05-27', '2026-08-27'],
    [6, '2026-05-27', '2026-11-27'],
    [1, '2026-01-31', '2026-02-28'],
    [1, '2028-01-31', '2028-02-29'],
    [6, '2026-08-31', '2027-02-28']
  ] as const)('adds %i calendar months to %s', (months, dateOnly, expected) => {
    expect(addDateMonths(dateOnly, months)).toBe(expected);
  });

  it('keeps the existing invalid date-only error', () => {
    expect(() => addDateMonths('2026-02-31', 1)).toThrow(/Invalid date-only value: 2026-02-31/);
  });

  it('validates the month count before adding months', () => {
    expect(() => addDateMonths('2026-05-27', 2 as never)).toThrow(/Subscription plan months must be 1, 3, or 6/);
  });
});
