import express from 'express';
import { ZodError } from 'zod';
import type { PublicSearchConfig } from './config.js';
import type { PublicSearchDatabase } from './db/database.js';
import { createPublicSearchStatusRouter } from './status.routes.js';
import { createPublicSearchStatusTracker } from './status-tracker.js';
import { createPublicSearchSyncRouter } from './sync.routes.js';

type PublicSearchStatusTracker = ReturnType<typeof createPublicSearchStatusTracker>;

type CreatePublicSearchAppOptions = {
  db: PublicSearchDatabase;
  config: PublicSearchConfig;
  statusTracker?: PublicSearchStatusTracker;
  subscriptionRouter?: express.Router | undefined;
};

function formatZodPath(path: Array<number | string>) {
  return path.map(String).join('.');
}

function getErrorStatus(error: unknown) {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const status = 'status' in error ? error.status : 'statusCode' in error ? error.statusCode : undefined;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : undefined;
}

function getErrorMessage(error: unknown) {
  if (!(error instanceof Error) || error.name !== 'SheetValidationError') {
    return undefined;
  }

  return error.message || undefined;
}

export function createPublicSearchApp(options: CreatePublicSearchAppOptions) {
  const app = express();
  const statusTracker = options.statusTracker ?? createPublicSearchStatusTracker();

  app.set('trust proxy', 'loopback');
  app.use('/api', createPublicSearchStatusRouter(options.config, statusTracker));
  app.use('/api', createPublicSearchSyncRouter(options.db, options.config, statusTracker));
  if (options.subscriptionRouter) {
    app.use('/api', options.subscriptionRouter);
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found' });
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'Validation failed',
        issues: error.issues.map((issue) => ({
          path: formatZodPath(issue.path),
          message: issue.message
        }))
      });
      return;
    }

    const status = getErrorStatus(error);
    if (status && status < 500) {
      res.status(status).json({ error: status === 413 ? 'Request body too large' : getErrorMessage(error) ?? 'Invalid request body' });
      return;
    }

    res.status(500).json({ error: 'Unexpected server error' });
  });

  return app;
}
