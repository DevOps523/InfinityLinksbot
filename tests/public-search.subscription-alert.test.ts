import { describe, expect, it, vi } from 'vitest';
import { createPublicSearchDatabase } from '../src/db/database.js';
import { migratePublicSearchDatabase } from '../src/db/migrate.js';
import { refreshSubscriptionAlert } from '../src/subscriptions/alert.service.js';
import { upsertSeenTelegramUser } from '../src/subscriptions/repository.js';

function createDb() {
  const db = createPublicSearchDatabase(':memory:');
  migratePublicSearchDatabase(db);
  return db;
}

type TestTelegram = {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
};

function createTelegram(overrides: Partial<TestTelegram> = {}) {
  const telegram = {
    sendMessage: vi.fn(async () => ({ messageId: 777 })),
    editMessageText: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined)
  };

  return { ...telegram, ...overrides };
}

function alertState(db: ReturnType<typeof createDb>) {
  return db.prepare('SELECT message_id AS messageId FROM subscription_alert_state WHERE id = 1').get();
}

describe('subscription alert service', () => {
  it('posts one alert for attention and unpaid users in deterministic order', async () => {
    const db = createDb();
    try {
      upsertSeenTelegramUser(db, { id: 43, username: 'unpaid_user' }, new Date('2026-05-26T00:00:00.000Z'));
      upsertSeenTelegramUser(db, { id: 42, username: 'need_pay' }, new Date('2026-05-26T00:00:00.000Z'));
      db.prepare("UPDATE subscription_users SET status = 'Unpaid' WHERE telegram_user_id = 43").run();
      db.prepare("UPDATE subscription_users SET status = 'Needs Attention' WHERE telegram_user_id = 42").run();
      const telegram = createTelegram();

      await expect(
        refreshSubscriptionAlert(db, telegram, {
          chatId: -1003963665033,
          messageThreadId: 46
        })
      ).resolves.toEqual({ state: 'posted', count: 2, messageId: 777 });

      expect(telegram.sendMessage).toHaveBeenCalledWith({
        chatId: -1003963665033,
        messageThreadId: 46,
        text: ['🚨 Subscription Alert', '', 'Your subscription is unpaid or almost expired. Please renew to keep access.', '', '@need_pay', '@unpaid_user'].join('\n')
      });
      expect(alertState(db)).toEqual({ messageId: 777 });
    } finally {
      db.close();
    }
  });

  it('edits an existing alert post', async () => {
    const db = createDb();
    try {
      upsertSeenTelegramUser(db, { id: 42, username: 'need_pay' }, new Date('2026-05-26T00:00:00.000Z'));
      db.prepare("UPDATE subscription_users SET status = 'Needs Attention' WHERE telegram_user_id = 42").run();
      db.prepare(
        "INSERT INTO subscription_alert_state (id, message_id, updated_at) VALUES (1, 777, '2026-05-26T00:00:00.000Z')"
      ).run();
      const telegram = createTelegram();

      await expect(refreshSubscriptionAlert(db, telegram, { chatId: -1003963665033, messageThreadId: 46 })).resolves.toEqual({
        state: 'updated',
        count: 1,
        messageId: 777
      });

      expect(telegram.editMessageText).toHaveBeenCalledWith({
        chatId: -1003963665033,
        messageId: 777,
        text: ['🚨 Subscription Alert', '', 'Your subscription is unpaid or almost expired. Please renew to keep access.', '', '@need_pay'].join('\n')
      });
      expect(telegram.sendMessage).not.toHaveBeenCalled();
      expect(alertState(db)).toEqual({ messageId: 777 });
    } finally {
      db.close();
    }
  });

  it('sends a fresh alert when the stored message is missing during edit', async () => {
    const db = createDb();
    try {
      upsertSeenTelegramUser(db, { id: 42, username: 'need_pay' }, new Date('2026-05-26T00:00:00.000Z'));
      db.prepare("UPDATE subscription_users SET status = 'Needs Attention' WHERE telegram_user_id = 42").run();
      db.prepare(
        "INSERT INTO subscription_alert_state (id, message_id, updated_at) VALUES (1, 777, '2026-05-26T00:00:00.000Z')"
      ).run();
      const telegram = createTelegram({
        editMessageText: vi.fn(async () => {
          throw new Error('Bad Request: message to edit not found');
        }),
        sendMessage: vi.fn(async () => ({ messageId: 888 }))
      });

      await expect(refreshSubscriptionAlert(db, telegram, { chatId: -1003963665033, messageThreadId: 46 })).resolves.toEqual({
        state: 'posted',
        count: 1,
        messageId: 888
      });

      expect(telegram.sendMessage).toHaveBeenCalledOnce();
      expect(alertState(db)).toEqual({ messageId: 888 });
    } finally {
      db.close();
    }
  });

  it('treats an unchanged Telegram edit as a successful update', async () => {
    const db = createDb();
    try {
      upsertSeenTelegramUser(db, { id: 42, username: 'need_pay' }, new Date('2026-05-26T00:00:00.000Z'));
      db.prepare("UPDATE subscription_users SET status = 'Needs Attention' WHERE telegram_user_id = 42").run();
      db.prepare(
        "INSERT INTO subscription_alert_state (id, message_id, updated_at) VALUES (1, 777, '2026-05-26T00:00:00.000Z')"
      ).run();
      const telegram = createTelegram({
        editMessageText: vi.fn(async () => {
          throw new Error('Bad Request: message is not modified');
        })
      });

      await expect(refreshSubscriptionAlert(db, telegram, { chatId: -1003963665033, messageThreadId: 46 })).resolves.toEqual({
        state: 'updated',
        count: 1,
        messageId: 777
      });

      expect(telegram.sendMessage).not.toHaveBeenCalled();
      expect(alertState(db)).toEqual({ messageId: 777 });
    } finally {
      db.close();
    }
  });

  it('truncates long alert lists to fit Telegram message limits', async () => {
    const db = createDb();
    try {
      for (let id = 1000; id < 1100; id += 1) {
        upsertSeenTelegramUser(
          db,
          { id, username: `user_${id}_${'x'.repeat(90)}` },
          new Date('2026-05-26T00:00:00.000Z')
        );
        db.prepare("UPDATE subscription_users SET status = 'Needs Attention' WHERE telegram_user_id = ?").run(id);
      }
      const telegram = createTelegram();

      await expect(refreshSubscriptionAlert(db, telegram, { chatId: -1003963665033, messageThreadId: 46 })).resolves.toEqual({
        state: 'posted',
        count: 100,
        messageId: 777
      });

      const text = telegram.sendMessage.mock.calls[0]?.[0].text as string;
      const truncatedMatch = text.match(/\.\.\.and (\d+) more users\.$/);
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text).toContain('@user_1000_');
      expect(text).not.toContain('@user_1099_');
      expect(truncatedMatch).not.toBeNull();
      expect(Number(truncatedMatch?.[1])).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('deletes the alert when no users need attention', async () => {
    const db = createDb();
    try {
      db.prepare(
        "INSERT INTO subscription_alert_state (id, message_id, updated_at) VALUES (1, 777, '2026-05-26T00:00:00.000Z')"
      ).run();
      const telegram = createTelegram();

      await expect(refreshSubscriptionAlert(db, telegram, { chatId: -1003963665033, messageThreadId: 46 })).resolves.toEqual({
        state: 'empty',
        count: 0
      });

      expect(telegram.deleteMessage).toHaveBeenCalledWith({ chatId: -1003963665033, messageId: 777 });
      expect(alertState(db)).toEqual({ messageId: null });
    } finally {
      db.close();
    }
  });

  it('throws and preserves state when Telegram cannot delete an old alert', async () => {
    const db = createDb();
    try {
      db.prepare(
        "INSERT INTO subscription_alert_state (id, message_id, updated_at) VALUES (1, 777, '2026-05-26T00:00:00.000Z')"
      ).run();
      const telegram = createTelegram({
        deleteMessage: vi.fn(async () => {
          throw new Error("Bad Request: message can't be deleted");
        })
      });

      await expect(refreshSubscriptionAlert(db, telegram, { chatId: -1003963665033, messageThreadId: 46 })).rejects.toThrow(
        /message can't be deleted/
      );

      expect(alertState(db)).toEqual({ messageId: 777 });
    } finally {
      db.close();
    }
  });

  it('clears stored state when delete reports the message is already missing', async () => {
    const db = createDb();
    try {
      db.prepare(
        "INSERT INTO subscription_alert_state (id, message_id, updated_at) VALUES (1, 777, '2026-05-26T00:00:00.000Z')"
      ).run();
      const telegram = createTelegram({
        deleteMessage: vi.fn(async () => {
          throw new Error('Bad Request: message to delete not found');
        })
      });

      await expect(refreshSubscriptionAlert(db, telegram, { chatId: -1003963665033, messageThreadId: 46 })).resolves.toEqual({
        state: 'empty',
        count: 0
      });

      expect(alertState(db)).toEqual({ messageId: null });
    } finally {
      db.close();
    }
  });

  it('uses a Telegram user id fallback when a username is unavailable', async () => {
    const db = createDb();
    try {
      upsertSeenTelegramUser(db, { id: 42 }, new Date('2026-05-26T00:00:00.000Z'));
      db.prepare("UPDATE subscription_users SET status = 'Needs Attention' WHERE telegram_user_id = 42").run();
      const telegram = createTelegram();

      await refreshSubscriptionAlert(db, telegram, { chatId: -1003963665033, messageThreadId: 46 });

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: ['🚨 Subscription Alert', '', 'Your subscription is unpaid or almost expired. Please renew to keep access.', '', 'User ID: 42'].join('\n')
        })
      );
    } finally {
      db.close();
    }
  });
});
