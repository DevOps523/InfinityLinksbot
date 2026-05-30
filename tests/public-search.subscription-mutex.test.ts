import { describe, expect, it } from 'vitest';
import { createAsyncMutex } from '../src/subscriptions/mutex.js';

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('subscription async mutex', () => {
  it('serializes overlapping subscription mutations', async () => {
    const mutex = createAsyncMutex();
    const events: string[] = [];

    const first = mutex.run(async () => {
      events.push('first:start');
      await delay(10);
      events.push('first:end');
    });
    const second = mutex.run(async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('continues after a failed mutation releases the lock', async () => {
    const mutex = createAsyncMutex();
    const events: string[] = [];

    await expect(
      mutex.run(async () => {
        events.push('first:start');
        throw new Error('failed mutation');
      })
    ).rejects.toThrow(/failed mutation/);

    await mutex.run(async () => {
      events.push('second:start');
    });

    expect(events).toEqual(['first:start', 'second:start']);
  });
});
