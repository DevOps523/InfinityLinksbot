import 'dotenv/config';
import { createPublicSearchApp } from './app.js';
import { loadPublicSearchConfig } from './config.js';
import { createPublicSearchDatabase } from './db/database.js';
import { migratePublicSearchDatabase } from './db/migrate.js';
import { createPublicTelegramClient } from './telegram.client.js';
import { createTelegramReplyQueue } from './telegram.reply-queue.js';
import { createReplyThrottleState, handleTelegramUpdate } from './bot/handlers.js';
import { createPublicSearchInteractionRateLimiter } from './bot/rate-policy.js';
import { pollOnce, type PollState } from './poller.js';
import { createPublicSearchStatusTracker } from './status-tracker.js';
import { todayDateString } from './subscriptions/date.js';
import { refreshSubscriptionAlert } from './subscriptions/alert.service.js';
import { handleSubscriptionBotUpdate } from './subscriptions/bot.handlers.js';
import { createGoogleSheetsClient } from './subscriptions/google-sheets.client.js';
import { enqueueSubscriptionJobIfNotActive, getSubscriptionJobHealth } from './subscriptions/job.repository.js';
import { processNextSubscriptionJob } from './subscriptions/job.processor.js';
import { createAsyncMutex } from './subscriptions/mutex.js';
import { createSubscriptionRouter } from './subscriptions/routes.js';
import { createDailySubscriptionRefreshRun, startDailySubscriptionRefreshLoop } from './subscriptions/scheduler.js';
import {
  getSubscriptionUser,
  isKickStillDue,
  markSubscriptionUserKickedIfStillDue,
  markSubscriptionUserUnbanned
} from './subscriptions/repository.js';
import { moveKickedUsersToHistory, syncSubscriptionsFromSheet } from './subscriptions/sync.service.js';

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main() {
  const config = loadPublicSearchConfig(process.env);
  const db = createPublicSearchDatabase(config.publicSearchDatabasePath);
  migratePublicSearchDatabase(db);
  const statusTracker = createPublicSearchStatusTracker();
  const publicTelegram = createPublicTelegramClient({ botToken: config.publicBotToken });
  const subscriptionTelegram = createPublicTelegramClient({ botToken: config.subscriptionBotToken });
  const sheets = createGoogleSheetsClient({
    spreadsheetId: config.googleSheetsSpreadsheetId,
    serviceAccountKeyFile: config.googleServiceAccountKeyFile,
    usersRange: config.googleSheetsUsersRange,
    historyRange: config.googleSheetsHistoryRange
  });
  const subscriptionMutationMutex = createAsyncMutex();

  const runRefreshAlert = () =>
    refreshSubscriptionAlert(db, subscriptionTelegram, {
      chatId: config.subscriptionGroupChatId,
      messageThreadId: config.subscriptionAlertThreadId
    });
  const refreshAlert = () => subscriptionMutationMutex.run(runRefreshAlert);
  const runSyncFromSheet = async () => {
    const result = await syncSubscriptionsFromSheet(db, sheets, {
      usersRange: config.googleSheetsUsersRange,
      historyRange: config.googleSheetsHistoryRange,
      now: new Date()
    });

    for (const user of result.paidUsers) {
      await subscriptionTelegram.unbanChatMember({
        chatId: config.subscriptionGroupChatId,
        userId: user.telegramUserId,
        onlyIfBanned: true
      });
      markSubscriptionUserUnbanned(db, user.telegramUserId, new Date());
    }

    return result;
  };
  const syncFromSheet = () => subscriptionMutationMutex.run(runSyncFromSheet);
  const scheduleSheetRefresh = (now: Date) => {
    const runAfter = new Date(now.getTime() + 5 * 60 * 1000);
    enqueueSubscriptionJobIfNotActive(db, 'refresh-sheet', {}, runAfter);
  };
  const subscriptionRouter = createSubscriptionRouter({
    adminToken: config.subscriptionAdminToken,
    syncFromSheet,
    refreshAlert
  });

  const app = createPublicSearchApp({ db, config, statusTracker, subscriptionRouter });
  app.listen(config.publicSearchPort, config.publicSearchHost, () => {
    console.log(`Public search sync API listening on http://${config.publicSearchHost}:${config.publicSearchPort}`);
  });

  const replies = createTelegramReplyQueue(publicTelegram);
  const rateLimiter = createPublicSearchInteractionRateLimiter();
  const replyThrottleState = createReplyThrottleState();
  const publicPollState: PollState = {};
  const subscriptionPollState: PollState = {};

  async function pollPublicBot() {
    while (true) {
      try {
        await pollOnce(
          publicPollState,
          publicTelegram,
          (update) =>
            handleTelegramUpdate(
              {
                db,
                subscription: {
                  now: () => new Date(),
                  trialSearchLimit: config.subscriptionTrialSearchLimit,
                  adminContact: config.subscriptionAdminContact,
                  scheduleSheetRefresh
                },
                replies,
                rateLimiter,
                replyThrottleState,
                groupHandle: config.publicSearchGroupHandle
              },
              update
            ),
          { allowedUpdates: ['message', 'callback_query'] }
        );
        statusTracker.clearError('telegram_poll');
      } catch (error) {
        statusTracker.recordError('telegram_poll', error);
        console.error('Public search polling failed', error);
        await delay(1_000);
      }
    }
  }

  async function pollSubscriptionBot() {
    while (true) {
      try {
        await pollOnce(
          subscriptionPollState,
          subscriptionTelegram,
          (update) =>
            handleSubscriptionBotUpdate(
              {
                db,
                now: () => new Date(),
                subscriptionGroupChatId: config.subscriptionGroupChatId
              },
              update
            ),
          { allowedUpdates: ['chat_member', 'my_chat_member'] }
        );
        statusTracker.clearError('subscription_telegram_poll');
      } catch (error) {
        statusTracker.recordError('subscription_telegram_poll', error);
        console.error('Subscription bot polling failed', error);
        await delay(1_000);
      }
    }
  }

  async function processSubscriptionJobs() {
    while (true) {
      try {
        const result = await processNextSubscriptionJob(db, {
          refreshAlert: async () => {
            await refreshAlert();
          },
          refreshSheet: async () => {
            await syncFromSheet();
          },
          kickUser: async (telegramUserId) => {
            await subscriptionMutationMutex.run(async () => {
              await runSyncFromSheet();
              const alreadyKickedUser = getSubscriptionUser(db, telegramUserId);
              if (alreadyKickedUser?.status === 'Kicked' && !alreadyKickedUser.historyExportedAt) {
                await moveKickedUsersToHistory(db, sheets, {
                  usersRange: config.googleSheetsUsersRange,
                  historyRange: config.googleSheetsHistoryRange,
                  users: [alreadyKickedUser]
                });
                return;
              }

              const now = new Date();
              if (
                !isKickStillDue(
                  db,
                  telegramUserId,
                  todayDateString(now),
                  config.subscriptionOverdueGraceDays
                )
              ) {
                return;
              }

              await subscriptionTelegram.banChatMember({
                chatId: config.subscriptionGroupChatId,
                userId: telegramUserId
              });
              const kicked = markSubscriptionUserKickedIfStillDue(
                db,
                telegramUserId,
                now,
                todayDateString(now),
                config.subscriptionOverdueGraceDays
              );
              if (!kicked) {
                return;
              }

              await moveKickedUsersToHistory(db, sheets, {
                usersRange: config.googleSheetsUsersRange,
                historyRange: config.googleSheetsHistoryRange,
                users: [kicked]
              });
            });
          }
        });
        if (result.failed) {
          statusTracker.recordError('subscription_jobs', result.error);
        } else {
          const health = getSubscriptionJobHealth(db);
          if (health.unhealthy) {
            statusTracker.recordError('subscription_jobs', formatSubscriptionJobHealthError(health));
          } else {
            statusTracker.clearError('subscription_jobs');
          }
        }
      } catch (error) {
        statusTracker.recordError('subscription_jobs', error);
        console.error('Subscription job processor failed', error);
      }
      await delay(1_000);
    }
  }

  startDailySubscriptionRefreshLoop({
    run: async () => {
      try {
        await createDailySubscriptionRefreshRun({
          db,
          overdueGraceDays: config.subscriptionOverdueGraceDays
        })();
        statusTracker.clearError('subscription_daily_refresh');
      } catch (error) {
        statusTracker.recordError('subscription_daily_refresh', error);
        console.error('Subscription daily refresh failed', error);
      }
    }
  });

  await Promise.all([pollPublicBot(), pollSubscriptionBot(), processSubscriptionJobs()]);
}

function formatSubscriptionJobHealthError(health: ReturnType<typeof getSubscriptionJobHealth>) {
  return new Error(
    `Subscription jobs unhealthy: ${health.failedJobs} failed, ${health.retryJobs} pending retry${
      health.lastError ? `; last error: ${health.lastError}` : ''
    }`
  );
}

main().catch((error) => {
  console.error('Public search service failed to start', error);
  process.exitCode = 1;
});
