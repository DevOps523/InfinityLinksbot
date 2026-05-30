import { describe, expect, it, vi } from 'vitest';
import { pollOnce, type PollState, type UpdateHandler } from '../src/poller.js';
import type { PublicTelegramClient, TelegramUpdate } from '../src/telegram.client.js';

function createClient(updates: TelegramUpdate[]) {
  return {
    getUpdates: vi.fn(async () => updates)
  } as unknown as PublicTelegramClient;
}

describe('public search poller', () => {
  it('calls getUpdates with the next offset and advances after received updates', async () => {
    const state: PollState = { nextOffset: 101 };
    const updates: TelegramUpdate[] = [
      { update_id: 101, message: { message_id: 1, chat: { id: 42 }, text: '/start' } },
      { update_id: 105, message: { message_id: 2, chat: { id: 42 }, text: '/search inception' } }
    ];
    const client = createClient(updates);
    const handleUpdate = vi.fn<UpdateHandler>(async () => {});

    await pollOnce(state, client, handleUpdate);

    expect(client.getUpdates).toHaveBeenCalledWith({ offset: 101, timeout: 30, allowedUpdates: undefined });
    expect(state.nextOffset).toBe(106);
  });

  it('passes allowed updates to getUpdates when provided', async () => {
    const state: PollState = {};
    const client = createClient([]);
    const handleUpdate = vi.fn<UpdateHandler>(async () => {});

    await pollOnce(state, client, handleUpdate, { allowedUpdates: ['message', 'chat_member'] });

    expect(client.getUpdates).toHaveBeenCalledWith({
      offset: undefined,
      timeout: 30,
      allowedUpdates: ['message', 'chat_member']
    });
  });

  it('passes each update to the update handler in order', async () => {
    const state: PollState = {};
    const updates: TelegramUpdate[] = [
      { update_id: 1, message: { message_id: 1, chat: { id: 42 }, text: '/start' } },
      { update_id: 2, callback_query: { id: 'callback-1', from: { id: 7 }, data: 'season:10' } }
    ];
    const client = createClient(updates);
    const handleUpdate = vi.fn<UpdateHandler>(async () => {});

    await pollOnce(state, client, handleUpdate);

    expect(handleUpdate).toHaveBeenNthCalledWith(1, updates[0]);
    expect(handleUpdate).toHaveBeenNthCalledWith(2, updates[1]);
  });

  it('catches handler errors, advances the offset, and continues polling remaining updates', async () => {
    const state: PollState = {};
    const updates: TelegramUpdate[] = [
      { update_id: 10, message: { message_id: 1, chat: { id: 42 }, text: '/start' } },
      { update_id: 11, message: { message_id: 2, chat: { id: 42 }, text: '/search broken' } },
      { update_id: 12, message: { message_id: 3, chat: { id: 42 }, text: '/search inception' } }
    ];
    const client = createClient(updates);
    const handleUpdate = vi.fn<UpdateHandler>(async (update) => {
      if (update.update_id === 11) {
        throw new Error('handler failed');
      }
    });

    await expect(pollOnce(state, client, handleUpdate)).resolves.toBeUndefined();

    expect(handleUpdate).toHaveBeenCalledTimes(3);
    expect(state.nextOffset).toBe(13);
  });
});
