import type { PublicSearchDatabase } from '../db/database.js';
import type { PublicTelegramClient } from '../telegram.client.js';
import { listUsersNeedingAlert, type SubscriptionUser } from './repository.js';

type AlertTelegramClient = Pick<PublicTelegramClient, 'sendMessage' | 'editMessageText' | 'deleteMessage'>;

export type RefreshSubscriptionAlertResult =
  | { state: 'empty'; count: 0 }
  | { state: 'posted' | 'updated'; count: number; messageId: number | undefined };

export type RefreshSubscriptionAlertOptions = {
  chatId: number;
  messageThreadId: number;
};

const TELEGRAM_TEXT_LIMIT = 4096;
const ALERT_HEADER_LINES = [
  '🚨 Subscription Alert',
  '',
  'Your subscription is unpaid or almost expired. Please renew to keep access.',
  ''
];

function usernameLine(user: SubscriptionUser) {
  return user.username ? `@${user.username}` : `User ID: ${user.telegramUserId}`;
}

export function formatSubscriptionAlert(users: SubscriptionUser[]) {
  const userLines = users.map(usernameLine);
  const includedUserLines: string[] = [];

  for (const userLine of userLines) {
    const remainingAfterLine = userLines.length - includedUserLines.length - 1;
    const candidate = formatAlertLines([
      ...includedUserLines,
      userLine,
      ...(remainingAfterLine > 0 ? [truncatedLine(remainingAfterLine)] : [])
    ]);

    if (candidate.length > TELEGRAM_TEXT_LIMIT) {
      break;
    }

    includedUserLines.push(userLine);
  }

  const truncatedCount = userLines.length - includedUserLines.length;
  return formatAlertLines([
    ...includedUserLines,
    ...(truncatedCount > 0 ? [truncatedLine(truncatedCount)] : [])
  ]);
}

function getStoredAlertMessageId(db: PublicSearchDatabase) {
  const row = db
    .prepare('SELECT message_id AS messageId FROM subscription_alert_state WHERE id = 1')
    .get() as { messageId: number | null } | undefined;

  return row?.messageId ?? undefined;
}

function storeAlertMessageId(db: PublicSearchDatabase, messageId: number | undefined) {
  db.prepare(
    `INSERT INTO subscription_alert_state (id, message_id, updated_at)
     VALUES (1, @messageId, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       message_id = excluded.message_id,
       updated_at = excluded.updated_at`
  ).run({
    messageId: messageId ?? null,
    updatedAt: new Date().toISOString()
  });
}

function formatAlertLines(lines: string[]) {
  return [...ALERT_HEADER_LINES, ...lines].join('\n');
}

function truncatedLine(count: number) {
  return `...and ${count} more users.`;
}

function isMessageNotModifiedError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /message is not modified/i.test(error.message);
}

function isMissingEditMessageError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /message to edit not found|message identifier is not specified|message_id_invalid/i.test(error.message);
}

function isMissingDeleteMessageError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return /message to delete not found|message identifier is not specified|message_id_invalid/i.test(error.message);
}

async function sendFreshAlert(
  db: PublicSearchDatabase,
  telegram: AlertTelegramClient,
  options: RefreshSubscriptionAlertOptions,
  text: string,
  count: number
): Promise<RefreshSubscriptionAlertResult> {
  const result = await telegram.sendMessage({
    chatId: options.chatId,
    messageThreadId: options.messageThreadId,
    text
  });
  storeAlertMessageId(db, result.messageId);
  return { state: 'posted', count, messageId: result.messageId };
}

export async function refreshSubscriptionAlert(
  db: PublicSearchDatabase,
  telegram: AlertTelegramClient,
  options: RefreshSubscriptionAlertOptions
): Promise<RefreshSubscriptionAlertResult> {
  const users = listUsersNeedingAlert(db);
  const existingMessageId = getStoredAlertMessageId(db);

  if (users.length === 0) {
    if (existingMessageId !== undefined) {
      try {
        await telegram.deleteMessage({ chatId: options.chatId, messageId: existingMessageId });
      } catch (error) {
        if (!isMissingDeleteMessageError(error)) {
          throw error;
        }
      }
      storeAlertMessageId(db, undefined);
    }

    return { state: 'empty', count: 0 };
  }

  const text = formatSubscriptionAlert(users);
  if (existingMessageId !== undefined) {
    try {
      await telegram.editMessageText({ chatId: options.chatId, messageId: existingMessageId, text });
      return { state: 'updated', count: users.length, messageId: existingMessageId };
    } catch (error) {
      if (isMessageNotModifiedError(error)) {
        return { state: 'updated', count: users.length, messageId: existingMessageId };
      }

      if (!isMissingEditMessageError(error)) {
        throw error;
      }
      return sendFreshAlert(db, telegram, options, text, users.length);
    }
  }

  return sendFreshAlert(db, telegram, options, text, users.length);
}
