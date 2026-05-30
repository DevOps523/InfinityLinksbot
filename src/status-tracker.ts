export type PublicSearchErrorSource =
  | 'startup'
  | 'telegram_poll'
  | 'subscription_telegram_poll'
  | 'subscription_jobs'
  | 'subscription_daily_refresh'
  | 'sync'
  | 'status_api'
  | 'unknown';

export type PublicSearchStatusState = 'ok' | 'error';

export type PublicSearchStatusError = {
  source: PublicSearchErrorSource;
  at: string;
  message: string;
};

export type PublicSearchStatusSnapshot = {
  state: PublicSearchStatusState;
  checkedAt: string;
  uptimeSeconds: number;
  consecutiveErrorCount: number;
  lastError: PublicSearchStatusError | null;
};

type PublicSearchStatusTrackerOptions = {
  now?: () => Date;
  uptimeSeconds?: () => number;
};

const ERROR_SOURCES = new Set<PublicSearchErrorSource>([
  'startup',
  'telegram_poll',
  'subscription_telegram_poll',
  'subscription_jobs',
  'subscription_daily_refresh',
  'sync',
  'status_api',
  'unknown'
]);

const MAX_MESSAGE_LENGTH = 240;
const REDACTED = '[redacted]';

function normalizeSource(source: PublicSearchErrorSource): PublicSearchErrorSource {
  return ERROR_SOURCES.has(source) ? source : 'unknown';
}

function toIsoString(value: Date): string {
  return value.toISOString();
}

function sanitizeErrorMessage(error: unknown): string {
  const rawMessage = error instanceof Error && error.message ? error.message : String(error);
  const firstLine = rawMessage.split(/\r?\n/)[0] ?? '';
  const normalized = firstLine
    .replace(/\s+/g, ' ')
    .replace(/Authorization:\s*Bearer\s+\S+/gi, `Authorization: Bearer ${REDACTED}`)
    .replace(/\b(token\s*[=:]\s*)(\S+)/gi, `$1${REDACTED}`)
    .replace(/\/bot\d+:[^/\s]+/gi, `/bot${REDACTED}`)
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, REDACTED)
    .trim();

  if (normalized.length <= MAX_MESSAGE_LENGTH) {
    return normalized;
  }

  return normalized.slice(0, MAX_MESSAGE_LENGTH);
}

export function createPublicSearchStatusTracker(options: PublicSearchStatusTrackerOptions = {}) {
  const now = options.now ?? (() => new Date());
  const uptimeSeconds = options.uptimeSeconds ?? (() => process.uptime());

  let consecutiveErrorCount = 0;
  let lastError: PublicSearchStatusError | null = null;

  function snapshot(): PublicSearchStatusSnapshot {
    return {
      state: lastError ? 'error' : 'ok',
      checkedAt: toIsoString(now()),
      uptimeSeconds: uptimeSeconds(),
      consecutiveErrorCount,
      lastError
    };
  }

  function recordError(source: PublicSearchErrorSource, error: unknown): PublicSearchStatusSnapshot {
    consecutiveErrorCount += 1;
    lastError = {
      source: normalizeSource(source),
      at: toIsoString(now()),
      message: sanitizeErrorMessage(error)
    };

    return snapshot();
  }

  function clearError(source: PublicSearchErrorSource): PublicSearchStatusSnapshot {
    if (lastError?.source === normalizeSource(source)) {
      consecutiveErrorCount = 0;
      lastError = null;
    }

    return snapshot();
  }

  return {
    recordError,
    clearError,
    snapshot
  };
}
