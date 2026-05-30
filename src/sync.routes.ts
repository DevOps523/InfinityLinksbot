import express from 'express';
import type { PublicSearchConfig } from './config.js';
import { replacePublicCatalog } from './catalog.repository.js';
import { PublicSearchCatalogSchema } from './catalog.schema.js';
import type { PublicSearchDatabase } from './db/database.js';
import { createFixedWindowRateLimiter } from './rate-limit.js';
import { createPublicSearchStatusTracker } from './status-tracker.js';

type PublicSearchStatusTracker = ReturnType<typeof createPublicSearchStatusTracker>;

function extractBearerToken(authorization: string | undefined) {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function createPublicSearchSyncRouter(
  db: PublicSearchDatabase,
  config: PublicSearchConfig,
  statusTracker: PublicSearchStatusTracker
) {
  const router = express.Router();
  const syncRateLimiter = createFixedWindowRateLimiter({ limit: 5, windowMs: 60_000 });
  const badAuthRateLimiter = createFixedWindowRateLimiter({ limit: 10, windowMs: 60_000 });
  const parseSyncJson = express.json({ limit: '5mb' });

  router.post('/sync', (req, res, next) => {
    const token = extractBearerToken(req.header('authorization'));
    const clientIp = req.ip ?? 'unknown';

    if (token !== config.publicSearchSyncToken) {
      const badAuthLimit = badAuthRateLimiter.check(clientIp);
      if (!badAuthLimit.allowed) {
        res.set('Retry-After', String(Math.max(1, Math.ceil(badAuthLimit.retryAfterMs / 1000))));
        res.status(429).json({ error: 'Too many unauthorized sync attempts. Please wait and try again.' });
        return;
      }

      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    parseSyncJson(req, res, next);
  }, (req, res) => {
    try {
      const token = extractBearerToken(req.header('authorization'));
      const clientIp = req.ip ?? 'unknown';
      const rateLimit = syncRateLimiter.check(`${clientIp}:${token?.slice(0, 8) ?? 'unknown'}`);
      if (!rateLimit.allowed) {
        res.set('Retry-After', String(Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1000))));
        res.status(429).json({ error: 'Too many sync attempts. Please wait and try again.' });
        return;
      }

      const catalog = PublicSearchCatalogSchema.parse(req.body);
      const counts = replacePublicCatalog(db, catalog);

      statusTracker.clearError('sync');
      res.json({ sync: counts });
    } catch (error) {
      statusTracker.recordError('sync', error);
      throw error;
    }
  });

  return router;
}
