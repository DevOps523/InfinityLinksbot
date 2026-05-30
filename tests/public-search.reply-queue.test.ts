import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramRateLimitError } from '../src/telegram.client.js';
import { createTelegramReplyQueue } from '../src/telegram.reply-queue.js';

describe('public search Telegram reply queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends messages in order', async () => {
    const sent: string[] = [];
    const client = {
      sendMessage: vi.fn(async (input: { text: string }) => {
        sent.push(input.text);
      }),
      answerCallbackQuery: vi.fn(async () => {})
    };
    const queue = createTelegramReplyQueue(client);

    const first = queue.enqueueSendMessage({ chatId: 1, text: 'first' });
    const second = queue.enqueueSendMessage({ chatId: 1, text: 'second' });
    const third = queue.enqueueSendMessage({ chatId: 1, text: 'third' });

    await queue.idle();
    await expect(Promise.all([first, second, third])).resolves.toEqual([undefined, undefined, undefined]);
    expect(sent).toEqual(['first', 'second', 'third']);
  });

  it('preserves mixed send and callback answer order', async () => {
    const actions: string[] = [];
    const client = {
      sendMessage: vi.fn(async (input: { text: string }) => {
        actions.push(`send:${input.text}`);
      }),
      answerCallbackQuery: vi.fn(async (input: { callbackQueryId: string }) => {
        actions.push(`callback:${input.callbackQueryId}`);
      })
    };
    const queue = createTelegramReplyQueue(client);

    const first = queue.enqueueSendMessage({ chatId: 1, text: 'first' });
    const second = queue.enqueueAnswerCallbackQuery({ callbackQueryId: 'callback-1', text: 'Loaded' });
    const third = queue.enqueueSendMessage({ chatId: 1, text: 'second' });

    await queue.idle();

    await expect(Promise.all([first, second, third])).resolves.toEqual([undefined, undefined, undefined]);
    expect(actions).toEqual(['send:first', 'callback:callback-1', 'send:second']);
  });

  it('pauses the queue and retries the same item after a Telegram 429', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new TelegramRateLimitError('Too Many Requests', 2))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const client = {
      sendMessage,
      answerCallbackQuery: vi.fn(async () => {})
    };
    const queue = createTelegramReplyQueue(client);

    const first = queue.enqueueSendMessage({ chatId: 1, text: 'retry me' });
    const second = queue.enqueueSendMessage({ chatId: 1, text: 'after retry' });

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]?.[0]).toEqual({ chatId: 1, text: 'retry me' });

    await vi.advanceTimersByTimeAsync(1999);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await queue.idle();

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(sendMessage.mock.calls.map(([input]) => input.text)).toEqual(['retry me', 'retry me', 'after retry']);
  });

  it('surfaces non-rate-limit errors and does not block future messages forever', async () => {
    const failure = new Error('Telegram exploded');
    const sendMessage = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const client = {
      sendMessage,
      answerCallbackQuery: vi.fn(async () => {})
    };
    const queue = createTelegramReplyQueue(client);

    const first = queue.enqueueSendMessage({ chatId: 1, text: 'fails' });
    const second = queue.enqueueSendMessage({ chatId: 1, text: 'continues' });

    await queue.idle();

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBeUndefined();
    expect(sendMessage.mock.calls.map(([input]) => input.text)).toEqual(['fails', 'continues']);
  });
});
