import { describe, expect, it } from 'vitest';
import { createPublicSearchStatusTracker } from '../src/status-tracker.js';

describe('public search status tracker', () => {
  it('starts in an ok state', () => {
    const tracker = createPublicSearchStatusTracker({
      now: () => new Date('2026-05-24T08:00:00.000Z'),
      uptimeSeconds: () => 12
    });

    expect(tracker.snapshot()).toEqual({
      state: 'ok',
      checkedAt: '2026-05-24T08:00:00.000Z',
      uptimeSeconds: 12,
      consecutiveErrorCount: 0,
      lastError: null
    });
  });

  it('records an error with a safe source, ISO timestamp, sanitized message, and count', () => {
    const tracker = createPublicSearchStatusTracker({
      now: () => new Date('2026-05-24T08:01:00.000Z'),
      uptimeSeconds: () => 20
    });

    expect(tracker.recordError('telegram_poll', new Error('Telegram polling failed\n    at poller.ts:12'))).toEqual({
      state: 'error',
      checkedAt: '2026-05-24T08:01:00.000Z',
      uptimeSeconds: 20,
      consecutiveErrorCount: 1,
      lastError: {
        source: 'telegram_poll',
        at: '2026-05-24T08:01:00.000Z',
        message: 'Telegram polling failed'
      }
    });
  });

  it('increments the consecutive error count when another error is recorded', () => {
    const tracker = createPublicSearchStatusTracker({
      now: () => new Date('2026-05-24T08:02:00.000Z'),
      uptimeSeconds: () => 30
    });

    tracker.recordError('sync', new Error('First sync failure'));

    expect(tracker.recordError('sync', new Error('Second sync failure'))).toMatchObject({
      state: 'error',
      consecutiveErrorCount: 2,
      lastError: {
        source: 'sync',
        message: 'Second sync failure'
      }
    });
  });

  it('clears a matching error source', () => {
    const tracker = createPublicSearchStatusTracker({
      now: () => new Date('2026-05-24T08:03:00.000Z'),
      uptimeSeconds: () => 40
    });

    tracker.recordError('startup', new Error('Missing token'));

    expect(tracker.clearError('startup')).toEqual({
      state: 'ok',
      checkedAt: '2026-05-24T08:03:00.000Z',
      uptimeSeconds: 40,
      consecutiveErrorCount: 0,
      lastError: null
    });
  });

  it('removes newlines and stack-like details from recorded messages', () => {
    const tracker = createPublicSearchStatusTracker({
      now: () => new Date('2026-05-24T08:04:00.000Z'),
      uptimeSeconds: () => 50
    });

    const snapshot = tracker.recordError(
      'status_api',
      new Error('Status route failed\r\n    at status.ts:10:5\r\n    at next')
    );

    expect(snapshot.lastError?.message).toBe('Status route failed');
    expect(snapshot.lastError?.message).not.toContain('\n');
    expect(snapshot.lastError?.message).not.toContain('status.ts:10:5');
  });

  it('redacts common secrets from public status messages', () => {
    const tracker = createPublicSearchStatusTracker({
      now: () => new Date('2026-05-24T08:05:00.000Z'),
      uptimeSeconds: () => 60
    });
    const bearerSecret = 'abc123SECRET456';
    const tokenSecret = 'secret-token-value';
    const colonTokenSecret = 'another-secret-token';
    const botTokenSecret = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const longSecret = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';

    tracker.recordError(
      'startup',
      new Error(
        `Request failed Authorization: Bearer ${bearerSecret} token=${tokenSecret} token: ${colonTokenSecret} https://api.telegram.org/bot${botTokenSecret}/sendMessage secret ${longSecret}`
      )
    );

    const message = tracker.snapshot().lastError?.message ?? '';

    expect(message).toContain('[redacted]');
    expect(message).not.toContain(bearerSecret);
    expect(message).not.toContain(tokenSecret);
    expect(message).not.toContain(colonTokenSecret);
    expect(message).not.toContain(botTokenSecret);
    expect(message).not.toContain(longSecret);
  });

  it('allows tracker methods to be destructured', () => {
    const tracker = createPublicSearchStatusTracker({
      now: () => new Date('2026-05-24T08:06:00.000Z'),
      uptimeSeconds: () => 70
    });
    const { recordError, clearError } = tracker;

    expect(recordError('sync', new Error('failed'))).toMatchObject({
      state: 'error',
      consecutiveErrorCount: 1
    });

    expect(clearError('sync')).toEqual({
      state: 'ok',
      checkedAt: '2026-05-24T08:06:00.000Z',
      uptimeSeconds: 70,
      consecutiveErrorCount: 0,
      lastError: null
    });
  });
});
