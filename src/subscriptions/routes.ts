import express from 'express';

function extractBearerToken(authorization: string | undefined) {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function createSubscriptionRouter(options: {
  adminToken: string;
  syncFromSheet: () => Promise<unknown>;
  refreshAlert: () => Promise<unknown>;
}) {
  const router = express.Router();

  router.use('/subscriptions', (req, res, next) => {
    const token = extractBearerToken(req.header('authorization'));
    if (token !== options.adminToken) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  });

  router.post('/subscriptions/update', async (_req, res, next) => {
    try {
      const subscriptions = await options.syncFromSheet();
      const alert = await options.refreshAlert();
      res.json({ subscriptions, alert });
    } catch (error) {
      next(error);
    }
  });

  router.post('/subscriptions/send-alert', async (_req, res, next) => {
    try {
      res.json({ alert: await options.refreshAlert() });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
