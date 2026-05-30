import type { PublicTelegramClient } from './telegram.client.js';
import { TelegramRateLimitError } from './telegram.client.js';

export type SendMessageInput = Parameters<PublicTelegramClient['sendMessage']>[0];
export type AnswerCallbackQueryInput = Parameters<PublicTelegramClient['answerCallbackQuery']>[0];

type ReplyQueueClient = Pick<PublicTelegramClient, 'sendMessage' | 'answerCallbackQuery'>;

type QueueItem =
  | {
      type: 'sendMessage';
      input: SendMessageInput;
      resolve: () => void;
      reject: (error: unknown) => void;
    }
  | {
      type: 'answerCallbackQuery';
      input: AnswerCallbackQueryInput;
      resolve: () => void;
      reject: (error: unknown) => void;
    };

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createTelegramReplyQueue(client: ReplyQueueClient) {
  const queue: QueueItem[] = [];
  const idleResolvers: Array<() => void> = [];
  let processing = false;

  function resolveIdleIfReady() {
    if (processing || queue.length > 0) {
      return;
    }

    const resolvers = idleResolvers.splice(0);
    for (const resolve of resolvers) {
      resolve();
    }
  }

  async function executeItem(item: QueueItem) {
    if (item.type === 'sendMessage') {
      await client.sendMessage(item.input);
      return;
    }

    await client.answerCallbackQuery(item.input);
  }

  async function processQueue() {
    if (processing) {
      return;
    }

    processing = true;

    while (queue.length > 0) {
      const item = queue[0];
      if (!item) {
        break;
      }

      try {
        await executeItem(item);
        item.resolve();
        queue.shift();
      } catch (error) {
        if (error instanceof TelegramRateLimitError) {
          await delay(error.retryAfter * 1000);
          continue;
        }

        item.reject(error);
        queue.shift();
      }
    }

    processing = false;
    resolveIdleIfReady();
  }

  function enqueue(item: Omit<QueueItem, 'resolve' | 'reject'>) {
    const promise = new Promise<void>((resolve, reject) => {
      queue.push({
        ...item,
        resolve,
        reject
      } as QueueItem);
    });

    void processQueue();
    return promise;
  }

  return {
    enqueueSendMessage(input: SendMessageInput): Promise<void> {
      return enqueue({
        type: 'sendMessage',
        input
      });
    },

    enqueueAnswerCallbackQuery(input: AnswerCallbackQueryInput): Promise<void> {
      return enqueue({
        type: 'answerCallbackQuery',
        input
      });
    },

    idle(): Promise<void> {
      if (!processing && queue.length === 0) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        idleResolvers.push(resolve);
      });
    }
  };
}
