import type { PublicSearchDatabase as AppDatabase } from '../db/database.js';
import type { TelegramUpdate } from '../telegram.client.js';
import type { createTelegramReplyQueue } from '../telegram.reply-queue.js';
import {
  getPublicSeasonDetails,
  hasPublicCatalog,
  searchPublicCatalog,
  type PublicSearchResult
} from '../search.repository.js';
import {
  classifyPublicSearchAccess,
  consumeSuccessfulSearchAccess,
  evaluateSearchAccess,
  type PublicSearchAccessClass
} from '../subscriptions/access.service.js';
import type { TelegramUserIdentity } from '../subscriptions/repository.js';
import { decodeSeasonCallback } from './callback-data.js';
import {
  formatNoResultsMessage,
  formatPlansMessage,
  formatPrivateChatRequiredMessage,
  formatSearchValidationMessage,
  formatSearchResults,
  formatSeasonDetails,
  formatStartMessage,
  formatSubscriptionRequiredMessage,
  formatUnavailableMessage,
  type PublicBotMessage
} from './formatter.js';
import type { PublicSearchInteractionRateLimiter, PublicSearchRateLimitAction } from './rate-policy.js';

type ReplyQueue = Pick<
  ReturnType<typeof createTelegramReplyQueue>,
  'enqueueSendMessage' | 'enqueueAnswerCallbackQuery'
>;

type ReplyUserKey = number | string;
type MessageChat = NonNullable<TelegramUpdate['message']>['chat'];

export type ReplyThrottleState = {
  shouldAllowFirstStart(userId: number | undefined): boolean;
  shouldSendWaitMessage(userId: number | undefined, retryAfterMs: number): boolean;
  clearWaitMessage(userId: number | undefined): void;
};

export type HandlerDeps = {
  db: AppDatabase;
  subscription: {
    now: () => Date;
    trialSearchLimit: number;
    adminContact: string;
    scheduleSheetRefresh?: ((now: Date) => void) | undefined;
  };
  replies: ReplyQueue;
  rateLimiter: PublicSearchInteractionRateLimiter;
  groupHandle: string;
  replyThrottleState?: ReplyThrottleState;
};

const FIRST_START_EXEMPTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REPLY_THROTTLE_STATE_LIMIT = 10_000;

export function createReplyThrottleState(options: { now?: () => number; maxEntries?: number } = {}): ReplyThrottleState {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_REPLY_THROTTLE_STATE_LIMIT;
  const firstStartUsers = new Map<ReplyUserKey, number>();
  const waitMessageUsers = new Map<ReplyUserKey, number>();

  return {
    shouldAllowFirstStart(userId) {
      const nowMs = now();
      pruneExpired(firstStartUsers, nowMs);

      const key = getUserKey(userId);
      if (firstStartUsers.has(key)) {
        return false;
      }

      rememberUntil(firstStartUsers, key, nowMs + FIRST_START_EXEMPTION_MS, maxEntries);
      return true;
    },
    shouldSendWaitMessage(userId, retryAfterMs) {
      const nowMs = now();
      pruneExpired(waitMessageUsers, nowMs);

      const key = getUserKey(userId);
      if (waitMessageUsers.has(key)) {
        return false;
      }

      rememberUntil(waitMessageUsers, key, nowMs + Math.max(1, retryAfterMs), maxEntries);
      return true;
    },
    clearWaitMessage(userId) {
      const nowMs = now();
      pruneExpired(waitMessageUsers, nowMs);
      waitMessageUsers.delete(getUserKey(userId));
    }
  };
}

export async function handleTelegramUpdate(deps: HandlerDeps, update: TelegramUpdate): Promise<void> {
  if (update.message) {
    await handleMessage(deps, update.message);
    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(deps, update.callback_query);
  }
}

async function handleMessage(deps: HandlerDeps, message: NonNullable<TelegramUpdate['message']>) {
  const text = message.text?.trim();

  if (!text) {
    return;
  }

  if (isCommand(text, 'start')) {
    const userId = message.from?.id;
    if (!getReplyThrottleState(deps).shouldAllowFirstStart(userId) && !(await replyIfAllowed(deps, message.chat.id, userId))) {
      return;
    }

    await sendBotMessage(deps, message.chat.id, formatStartMessage(getHandles(deps)));
    return;
  }

  if (isCommand(text, 'plans')) {
    if (!(await replyIfAllowed(deps, message.chat.id, message.from?.id))) {
      return;
    }

    await sendBotMessage(deps, message.chat.id, formatPlansMessage(deps.subscription.adminContact));
    return;
  }

  if (isCommand(text, 'search')) {
    const query = getCommandArgument(text);

    if (!query) {
      if (!(await replyIfAllowed(deps, message.chat.id, message.from?.id))) {
        return;
      }

      await sendBotMessage(deps, message.chat.id, formatSearchValidationMessage());
      return;
    }

    const user = getTelegramUser(message.from);
    const accessClass = classifyPublicSearchAccess(deps.db, {
      user,
      trialSearchLimit: deps.subscription.trialSearchLimit
    });

    if (accessClass === 'blocked') {
      await sendSubscriptionRequiredIfAllowed(deps, message.chat.id, user?.id);
      return;
    }

    if (!(await replyIfAllowed(deps, message.chat.id, user?.id, 'search', accessClass))) {
      return;
    }

    await handleSearch(deps, message.chat, user, query);
    return;
  }

  if (text.startsWith('/')) {
    if (!(await replyIfAllowed(deps, message.chat.id, message.from?.id))) {
      return;
    }

    await sendBotMessage(deps, message.chat.id, formatStartMessage(getHandles(deps)));
  }
}

async function handleSearch(deps: HandlerDeps, chat: MessageChat, user: TelegramUserIdentity | undefined, query: string) {
  const chatId = chat.id;

  if (!hasPublicCatalog(deps.db)) {
    await sendBotMessage(deps, chatId, formatUnavailableMessage());
    return;
  }

  const results = searchPublicCatalog(deps.db, query, 10);
  if (hasProviderLinks(results) && !isPrivateChat(chat)) {
    await sendBotMessage(deps, chatId, formatPrivateChatRequiredMessage());
    return;
  }

  if (results.length === 0) {
    await sendBotMessage(deps, chatId, formatNoResultsMessage(getHandles(deps)));
    return;
  }

  const now = deps.subscription.now();
  const access = consumeSuccessfulSearchAccess(deps.db, {
    user,
    now,
    trialSearchLimit: deps.subscription.trialSearchLimit
  });

  if (!access.allowed) {
    await sendSubscriptionRequiredIfAllowed(deps, chatId, user?.id);
    return;
  }

  deps.subscription.scheduleSheetRefresh?.(now);

  const messages = formatSearchResults(results, getHandles(deps));

  for (const message of messages) {
    await sendBotMessage(deps, chatId, message);
  }
}

async function handleCallbackQuery(deps: HandlerDeps, callbackQuery: NonNullable<TelegramUpdate['callback_query']>) {
  const callbackQueryId = callbackQuery.id;
  const seasonId = callbackQuery.data ? decodeSeasonCallback(callbackQuery.data) : undefined;

  if (!seasonId) {
    await deps.replies.enqueueAnswerCallbackQuery({
      callbackQueryId,
      text: 'That button is no longer available.'
    });
    return;
  }

  const details = getPublicSeasonDetails(deps.db, seasonId);

  if (!details) {
    await deps.replies.enqueueAnswerCallbackQuery({
      callbackQueryId,
      text: 'That button is no longer available.'
    });
    return;
  }

  const callbackUser = getTelegramUser(callbackQuery.from);
  const accessClass = classifyPublicSearchAccess(deps.db, {
    user: callbackUser,
    trialSearchLimit: deps.subscription.trialSearchLimit
  });

  if (accessClass === 'blocked') {
    await answerSubscriptionRequiredIfAllowed(deps, callbackQueryId, callbackQuery.message?.chat.id, callbackUser?.id);
    return;
  }

  const rateLimit = checkReplyRateLimit(deps, {
    userId: callbackUser?.id,
    action: 'season',
    accessClass
  });
  if (!rateLimit.allowed) {
    await deps.replies.enqueueAnswerCallbackQuery({
      callbackQueryId,
      text: formatWaitMessage(rateLimit.retryAfterMs)
    });
    return;
  }

  const chat = callbackQuery.message?.chat;
  if (!chat || !isPrivateChat(chat)) {
    await deps.replies.enqueueAnswerCallbackQuery({
      callbackQueryId,
      text: 'Open a private chat with this bot to view download links.'
    });
    return;
  }

  const chatId = chat.id;
  const now = deps.subscription.now();
  const access = evaluateSearchAccess(deps.db, {
    user: callbackUser,
    now,
    trialSearchLimit: deps.subscription.trialSearchLimit
  });

  if (!access.allowed) {
    await answerSubscriptionRequiredIfAllowed(deps, callbackQueryId, chatId, callbackUser?.id);
    return;
  }

  deps.subscription.scheduleSheetRefresh?.(now);

  if (!hasPublicCatalog(deps.db)) {
    await deps.replies.enqueueAnswerCallbackQuery({
      callbackQueryId,
      text: 'Search is temporarily unavailable.'
    });
    if (chatId !== undefined) {
      await sendBotMessage(deps, chatId, formatUnavailableMessage());
    }
    return;
  }

  await deps.replies.enqueueAnswerCallbackQuery({ callbackQueryId });

  for (const message of formatSeasonDetails(details, getHandles(deps))) {
    await sendBotMessage(deps, chat.id, message);
  }
}

async function sendBotMessage(deps: HandlerDeps, chatId: number, message: PublicBotMessage) {
  await deps.replies.enqueueSendMessage({
    chatId,
    text: message.text,
    replyMarkup: message.replyMarkup
  });
}

function getUserKey(userId: number | undefined) {
  return userId ?? 'unknown';
}

function checkReplyRateLimit(
  deps: HandlerDeps,
  input: {
    userId: number | undefined;
    action: PublicSearchRateLimitAction;
    accessClass?: PublicSearchAccessClass | undefined;
  }
) {
  return deps.rateLimiter.check(input);
}

async function sendRateLimitMessage(deps: HandlerDeps, chatId: number, userId: number | undefined, retryAfterMs: number) {
  if (!getReplyThrottleState(deps).shouldSendWaitMessage(userId, retryAfterMs)) {
    return;
  }

  await deps.replies.enqueueSendMessage({
    chatId,
    text: formatWaitMessage(retryAfterMs)
  });
}

async function replyIfAllowed(
  deps: HandlerDeps,
  chatId: number,
  userId: number | undefined,
  action: PublicSearchRateLimitAction = 'message',
  accessClass?: PublicSearchAccessClass | undefined
) {
  const rateLimit = checkReplyRateLimit(deps, { userId, action, accessClass });
  if (rateLimit.allowed) {
    getReplyThrottleState(deps).clearWaitMessage(userId);
    return true;
  }

  await sendRateLimitMessage(deps, chatId, userId, rateLimit.retryAfterMs);
  return false;
}

async function sendSubscriptionRequiredIfAllowed(
  deps: HandlerDeps,
  chatId: number,
  userId: number | undefined
) {
  if (!(await replyIfAllowed(deps, chatId, userId, 'blocked-message', 'blocked'))) {
    return;
  }

  await sendBotMessage(deps, chatId, formatSubscriptionRequiredMessage(deps.subscription.adminContact));
}

async function answerSubscriptionRequiredIfAllowed(
  deps: HandlerDeps,
  callbackQueryId: string,
  chatId: number | undefined,
  userId: number | undefined
) {
  const rateLimit = checkReplyRateLimit(deps, {
    userId,
    action: 'blocked-message',
    accessClass: 'blocked'
  });

  if (!rateLimit.allowed) {
    await deps.replies.enqueueAnswerCallbackQuery({
      callbackQueryId,
      text: formatWaitMessage(rateLimit.retryAfterMs)
    });
    return;
  }

  await deps.replies.enqueueAnswerCallbackQuery({
    callbackQueryId,
    text: 'Subscription required.'
  });

  if (chatId !== undefined) {
    await sendBotMessage(deps, chatId, formatSubscriptionRequiredMessage(deps.subscription.adminContact));
  }
}

function getReplyThrottleState(deps: HandlerDeps) {
  deps.replyThrottleState ??= createReplyThrottleState();
  return deps.replyThrottleState;
}

function hasProviderLinks(results: PublicSearchResult[]) {
  return results.some((result) => result.type === 'movie' && result.providers.length > 0);
}

function isPrivateChat(chat: Pick<MessageChat, 'type'>) {
  return chat.type === 'private';
}

function pruneExpired(entries: Map<ReplyUserKey, number>, nowMs: number) {
  for (const [key, expiresAtMs] of entries) {
    if (expiresAtMs <= nowMs) {
      entries.delete(key);
    }
  }
}

function rememberUntil(entries: Map<ReplyUserKey, number>, key: ReplyUserKey, expiresAtMs: number, maxEntries: number) {
  entries.set(key, expiresAtMs);

  while (entries.size > maxEntries) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    entries.delete(oldestKey);
  }
}

function isCommand(text: string, command: string) {
  return new RegExp(`^/${command}(?:@\\w+)?(?:\\s|$)`, 'i').test(text);
}

function getCommandArgument(text: string) {
  return text.replace(/^\/\w+(?:@\w+)?\s*/i, '').trim();
}

function getHandles(deps: HandlerDeps) {
  return {
    groupHandle: deps.groupHandle
  };
}

function getTelegramUser(from: { id: number; username?: string } | undefined): TelegramUserIdentity | undefined {
  return from ? { id: from.id, username: from.username } : undefined;
}

function formatWaitMessage(retryAfterMs: number) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return `Please wait ${seconds} ${seconds === 1 ? 'second' : 'seconds'} before trying again.`;
}
