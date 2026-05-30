import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSubscriptionBotUpdate } from '../src/subscriptions/bot.handlers.js';
import { upsertSeenTelegramUser } from '../src/subscriptions/repository.js';

vi.mock('../src/subscriptions/repository.js', () => ({
  upsertSeenTelegramUser: vi.fn()
}));

type FakeUserRow = {
  telegramUserId: number;
  username?: string | undefined;
  status: string;
  removedFromGroup: boolean;
  updatedAt?: string | undefined;
};

function createFakeDb(seed: FakeUserRow[] = []) {
  const users = new Map(seed.map((user) => [user.telegramUserId, { ...user }]));
  const preparedSql: string[] = [];
  const updateRemovedFromGroup = vi.fn(
    (input: { telegramUserId: number; removedFromGroup: 0 | 1; updatedAt: string }) => {
      const user = users.get(input.telegramUserId);
      if (user && user.status !== 'Kicked') {
        user.removedFromGroup = input.removedFromGroup === 1;
        user.updatedAt = input.updatedAt;
      }
    }
  );

  return {
    users,
    preparedSql,
    updateRemovedFromGroup,
    db: {
      prepare: vi.fn((sql: string) => {
        preparedSql.push(sql);
        return {
          run: updateRemovedFromGroup
        };
      })
    }
  };
}

const mockedUpsertSeenTelegramUser = vi.mocked(upsertSeenTelegramUser);

describe('subscription bot handlers', () => {
  beforeEach(() => {
    mockedUpsertSeenTelegramUser.mockReset();
  });

  it('records latest username from subscription group chat member updates by stable user id', async () => {
    const fake = createFakeDb([{ telegramUserId: 42, status: 'Unpaid', removedFromGroup: true }]);
    const deps = {
      db: fake.db,
      now: () => new Date('2026-05-26T00:00:00.000Z'),
      subscriptionGroupChatId: -1003963665033
    };

    await handleSubscriptionBotUpdate(deps, {
      update_id: 1,
      chat_member: {
        chat: { id: -1003963665033 },
        from: { id: 99, username: 'admin' },
        date: 1779753600,
        old_chat_member: { status: 'left', user: { id: 42, username: 'old_name' } },
        new_chat_member: { status: 'member', user: { id: 42, username: 'new_name' } }
      }
    });

    await handleSubscriptionBotUpdate(
      { ...deps, now: () => new Date('2026-05-26T01:00:00.000Z') },
      {
        update_id: 2,
        chat_member: {
          chat: { id: -1003963665033 },
          from: { id: 99, username: 'admin' },
          date: 1779757200,
          old_chat_member: { status: 'member', user: { id: 42, username: 'new_name' } },
          new_chat_member: { status: 'member', user: { id: 42, username: 'newer_name' } }
        }
      }
    );

    expect(mockedUpsertSeenTelegramUser).toHaveBeenNthCalledWith(1, fake.db, { id: 42, username: 'new_name' }, new Date('2026-05-26T00:00:00.000Z'));
    expect(mockedUpsertSeenTelegramUser).toHaveBeenNthCalledWith(2, fake.db, { id: 42, username: 'newer_name' }, new Date('2026-05-26T01:00:00.000Z'));
    expect(fake.users.get(42)).toMatchObject({ status: 'Unpaid', removedFromGroup: false });
  });

  it('clears removed-from-group when a previously seen paid user rejoins without changing status', async () => {
    const fake = createFakeDb([{ telegramUserId: 42, username: 'paid_user', status: 'Subscribe', removedFromGroup: true }]);

    await handleSubscriptionBotUpdate(
      {
        db: fake.db,
        now: () => new Date('2026-05-26T01:00:00.000Z'),
        subscriptionGroupChatId: -1003963665033
      },
      {
        update_id: 1,
        chat_member: {
          chat: { id: -1003963665033 },
          from: { id: 99, username: 'admin' },
          date: 1779757200,
          old_chat_member: { status: 'left', user: { id: 42, username: 'paid_user' } },
          new_chat_member: { status: 'member', user: { id: 42, username: 'paid_user_renamed' } }
        }
      }
    );

    expect(fake.users.get(42)).toMatchObject({
      status: 'Subscribe',
      removedFromGroup: false,
      updatedAt: '2026-05-26T01:00:00.000Z'
    });
  });

  it('records removal from the configured group without marking users kicked', async () => {
    const fake = createFakeDb([{ telegramUserId: 42, username: 'paid_user', status: 'Subscribe', removedFromGroup: false }]);

    await handleSubscriptionBotUpdate(
      {
        db: fake.db,
        now: () => new Date('2026-05-26T00:00:00.000Z'),
        subscriptionGroupChatId: -1003963665033
      },
      {
        update_id: 1,
        chat_member: {
          chat: { id: -1003963665033 },
          from: { id: 99, username: 'admin' },
          date: 1779753600,
          old_chat_member: { status: 'member', user: { id: 42, username: 'paid_user' } },
          new_chat_member: { status: 'kicked', user: { id: 42, username: 'paid_user' } }
        }
      }
    );

    expect(fake.users.get(42)).toMatchObject({ status: 'Subscribe', removedFromGroup: true });
  });

  it('uses is_member to decide whether restricted members are active or removed', async () => {
    const fake = createFakeDb([
      { telegramUserId: 42, username: 'limited_active', status: 'Subscribe', removedFromGroup: true },
      { telegramUserId: 43, username: 'limited_removed', status: 'Subscribe', removedFromGroup: false }
    ]);
    const deps = {
      db: fake.db,
      now: () => new Date('2026-05-26T00:00:00.000Z'),
      subscriptionGroupChatId: -1003963665033
    };

    await handleSubscriptionBotUpdate(deps, {
      update_id: 1,
      chat_member: {
        chat: { id: -1003963665033 },
        from: { id: 99, username: 'admin' },
        date: 1779753600,
        old_chat_member: { status: 'member', user: { id: 42, username: 'limited_active' } },
        new_chat_member: {
          status: 'restricted',
          is_member: true,
          user: { id: 42, username: 'limited_active' }
        }
      }
    });
    await handleSubscriptionBotUpdate(deps, {
      update_id: 2,
      chat_member: {
        chat: { id: -1003963665033 },
        from: { id: 99, username: 'admin' },
        date: 1779753600,
        old_chat_member: { status: 'member', user: { id: 43, username: 'limited_removed' } },
        new_chat_member: {
          status: 'restricted',
          is_member: false,
          user: { id: 43, username: 'limited_removed' }
        }
      }
    });

    expect(fake.preparedSql.join('\n')).toContain('status != \'Kicked\'');
    expect(fake.updateRemovedFromGroup).toHaveBeenNthCalledWith(1, {
      telegramUserId: 42,
      removedFromGroup: 0,
      updatedAt: '2026-05-26T00:00:00.000Z'
    });
    expect(fake.updateRemovedFromGroup).toHaveBeenNthCalledWith(2, {
      telegramUserId: 43,
      removedFromGroup: 1,
      updatedAt: '2026-05-26T00:00:00.000Z'
    });
    expect(fake.users.get(42)).toMatchObject({ status: 'Subscribe', removedFromGroup: false });
    expect(fake.users.get(43)).toMatchObject({ status: 'Subscribe', removedFromGroup: true });
  });

  it('ignores unrelated groups, bot targets, malformed member events, and non-member updates', async () => {
    const fake = createFakeDb();
    const deps = {
      db: fake.db,
      now: () => new Date('2026-05-26T00:00:00.000Z'),
      subscriptionGroupChatId: -1003963665033,
      botUserId: 777
    };

    await handleSubscriptionBotUpdate(deps, {
      update_id: 1,
      chat_member: {
        chat: { id: -1001 },
        from: { id: 99, username: 'admin' },
        date: 1779753600,
        old_chat_member: { status: 'left', user: { id: 42, username: 'wrong_group' } },
        new_chat_member: { status: 'member', user: { id: 42, username: 'wrong_group' } }
      }
    });
    await handleSubscriptionBotUpdate(deps, {
      update_id: 2,
      my_chat_member: {
        chat: { id: -1003963665033 },
        from: { id: 99, username: 'admin' },
        date: 1779753600,
        old_chat_member: { status: 'left', user: { id: 777, username: 'subscription_bot' } },
        new_chat_member: { status: 'member', user: { id: 777, username: 'subscription_bot' } }
      }
    });
    await handleSubscriptionBotUpdate(deps, {
      update_id: 3,
      chat_member: {
        chat: { id: -1003963665033 },
        from: { id: 99, username: 'admin' },
        date: 1779753600,
        old_chat_member: { status: 'left' },
        new_chat_member: { status: 'member' }
      }
    });
    await handleSubscriptionBotUpdate(deps, { update_id: 4 });

    expect(mockedUpsertSeenTelegramUser).not.toHaveBeenCalled();
    expect(fake.updateRemovedFromGroup).not.toHaveBeenCalled();
  });
});
