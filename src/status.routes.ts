import express from 'express';
import type { PublicSearchConfig } from './config.js';
import type { PublicSearchStatusSnapshot } from './status-tracker.js';

type PublicSearchStatusTracker = {
  snapshot: () => PublicSearchStatusSnapshot;
};

function extractBearerToken(authorization: string | undefined) {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function createPublicSearchStatusRouter(
  config: PublicSearchConfig,
  statusTracker: PublicSearchStatusTracker
) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const token = extractBearerToken(req.header('authorization'));
    if (token !== config.publicSearchStatusToken) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    res.json(statusTracker.snapshot());
  });

  return router;
}
