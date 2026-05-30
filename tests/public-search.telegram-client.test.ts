import { describe, expect, it, vi } from 'vitest';
import {
  createPublicTelegramClient,
  TelegramRateLimitError
} from '../src/telegram.client.js';

function getJsonBody(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0) {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('public Telegram client', () => {
  it('sendMessage sends chat_id, text, and reply_markup', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: { message_id: 123 } }));
    const client = createPublicTelegramClient({ botToken: 'bot-token' }, fetchMock);
    const replyMarkup = {
      inline_keyboard: [[{ text: 'Open', url: 'https://example.com' }]]
    };

    await client.sendMessage({
      chatId: 42,
      text: 'Hello',
      replyMarkup
    });

    expect(fetchMock).toHaveBeenCalledWith('https://api.telegram.org/botbot-token/sendMessage', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: 42,
        text: 'Hello',
        reply_markup: replyMarkup
      })
    });
  });

  it('sendMessage supports message threads and returns the message id', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: { message_id: 777 } }));
    const client = createPublicTelegramClient({ botToken: 'bot-token' }, fetchMock);

    await expect(client.sendMessage({
      chatId: -1003963665033,
      messageThreadId: 46,
      text: 'Alert'
    })).resolves.toEqual({ messageId: 777 });

    expect(getJsonBody(fetchMock)).toEqual({
      chat_id: -1003963665033,
      message_thread_id: 46,
      text: 'Alert'
    });
  });

  it('edits and deletes messages', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: true }));
    const client = createPublicTelegramClient({ botToken: 'bot-token' }, fetchMock);

    await client.editMessageText({ chatId: -1003963665033, messageId: 777, text: 'Updated' });
    await client.deleteMessage({ chatId: -1003963665033, messageId: 777 });

    expect(getJsonBody(fetchMock, 0)).toEqual({ chat_id: -1003963665033, message_id: 777, text: 'Updated' });
    expect(getJsonBody(fetchMock, 1)).toEqual({ chat_id: -1003963665033, message_id: 777 });
  });

  it('bans a chat member without immediately unbanning them', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: true }));
    const client = createPublicTelegramClient({ botToken: 'bot-token' }, fetchMock);

    await client.banChatMember({ chatId: -1003963665033, userId: 42 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getJsonBody(fetchMock, 0)).toEqual({ chat_id: -1003963665033, user_id: 42, revoke_messages: false });
  });

  it('unbanChatMember sends the unban payload', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: true }));
    const client = createPublicTelegramClient({ botToken: 'bot-token' }, fetchMock);

    await client.unbanChatMember({ chatId: -1003963665033, userId: 42, onlyIfBanned: true });

    expect(getJsonBody(fetchMock)).toEqual({
      chat_id: -1003963665033,
      user_id: 42,
      only_if_banned: true
    });
  });

  it('answerCallbackQuery sends the callback query ID', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: true }));
    const client = createPublicTelegramClient({ botToken: 'bot-token' }, fetchMock);

    await client.answerCallbackQuery({
      callbackQueryId: 'callback-1',
      text: 'Loaded'
    });

    expect(fetchMock).toHaveBeenCalledWith('https://api.telegram.org/botbot-token/answerCallbackQuery', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        callback_query_id: 'callback-1',
        text: 'Loaded'
      })
    });
  });

  it('getUpdates passes offset and timeout', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        result: [
          {
            update_id: 100,
            message: {
              message_id: 10,
              chat: { id: 42 },
              from: { id: 7 },
              text: '/start'
            }
          }
        ]
      })
    );
    const client = createPublicTelegramClient({ botToken: 'bot-token' }, fetchMock);

    const updates = await client.getUpdates({ offset: 101, timeout: 30 });

    expect(fetchMock).toHaveBeenCalledWith('https://api.telegram.org/botbot-token/getUpdates', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        offset: 101,
        timeout: 30
      })
    });
    expect(updates).toEqual([
      expect.objectContaining({
        update_id: 100
      })
    ]);
  });

  it('getUpdates can request allowed update types', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, result: [] }));
    const client = createPublicTelegramClient({ botToken: 'bot-token' }, fetchMock);

    await client.getUpdates({ offset: 101, timeout: 30, allowedUpdates: ['message', 'chat_member'] });

    expect(getJsonBody(fetchMock)).toEqual({
      offset: 101,
      timeout: 30,
      allowed_updates: ['message', 'chat_member']
    });
  });

  it('getChatMember returns chat member status', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        result: {
          status: 'member'
        }
      })
    );
    const client = createPublicTelegramClient({ botToken: 'bot-token' }, fetchMock);

    const member = await client.getChatMember({
      chatId: '@infinitylinks65',
      userId: 7
    });

    expect(getJsonBody(fetchMock)).toEqual({
      chat_id: '@infinitylinks65',
      user_id: 7
    });
    expect(member.status).toBe('member');
  });

  it('Telegram 429 throws an error with retryAfter', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry later',
          parameters: {
            retry_after: 12
          }
        },
        { status: 429 }
      )
    );
    const client = createPublicTelegramClient({ botToken: 'bot-token' }, fetchMock);

    await expect(client.sendMessage({ chatId: 42, text: 'Hello' })).rejects.toMatchObject({
      name: 'TelegramRateLimitError',
      message: 'Too Many Requests: retry later',
      retryAfter: 12
    });
    await expect(client.sendMessage({ chatId: 42, text: 'Hello' })).rejects.toBeInstanceOf(TelegramRateLimitError);
  });

  it('invalid JSON returns a clear error', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 200 }));
    const client = createPublicTelegramClient({ botToken: 'bot-token' }, fetchMock);

    await expect(client.getUpdates({})).rejects.toThrow('Telegram getUpdates returned invalid JSON');
  });
});
