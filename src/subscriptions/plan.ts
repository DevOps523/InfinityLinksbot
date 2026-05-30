export type SubscriptionPlanMonths = 1 | 3 | 6;

export const DEFAULT_SUBSCRIPTION_PLAN_MONTHS: SubscriptionPlanMonths = 1;
export const SUBSCRIPTION_PLAN_MONTHS = [1, 3, 6] as const satisfies readonly SubscriptionPlanMonths[];

const PLAN_LABELS: Record<SubscriptionPlanMonths, string> = {
  1: '1 Month',
  3: '3 Months',
  6: '6 Months'
};

const NORMALIZED_PLAN_VALUES: Record<string, SubscriptionPlanMonths> = {
  '1': 1,
  '1 month': 1,
  '1 months': 1,
  'one month': 1,
  '3': 3,
  '3 month': 3,
  '3 months': 3,
  'three months': 3,
  '6': 6,
  '6 month': 6,
  '6 months': 6,
  'six months': 6
};

export function validateSubscriptionPlanMonths(months: number): asserts months is SubscriptionPlanMonths {
  if (!SUBSCRIPTION_PLAN_MONTHS.includes(months as SubscriptionPlanMonths)) {
    throw new Error('Subscription plan months must be 1, 3, or 6');
  }
}

export function subscriptionPlanLabel(months: SubscriptionPlanMonths) {
  validateSubscriptionPlanMonths(months);
  return PLAN_LABELS[months];
}

export function normalizeSubscriptionPlan(value: unknown): SubscriptionPlanMonths | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const text = String(value).trim();
  if (text === '') {
    return undefined;
  }

  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  const months = NORMALIZED_PLAN_VALUES[normalized];
  if (months !== undefined) {
    return months;
  }

  throw new Error(`Invalid Plan: ${text}. Expected 1 Month, 3 Months, or 6 Months`);
}
