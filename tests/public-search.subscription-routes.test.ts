import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createSubscriptionRouter } from '../src/subscriptions/routes.js';

describe('subscription routes', () => {
  it('requires subscription admin bearer token', async () => {
    const app = express();
    app.use('/api', createSubscriptionRouter({
      adminToken: 'admin-token',
      syncFromSheet: vi.fn(),
      refreshAlert: vi.fn()
    }));

    expect((await request(app).post('/api/subscriptions/update')).status).toBe(401);
    expect((await request(app).post('/api/subscriptions/send-alert').set('Authorization', 'Bearer wrong')).status).toBe(401);
  });

  it('runs update and send-alert actions', async () => {
    const app = express();
    const syncFromSheet = vi.fn(async () => ({ updatedUsers: 2 }));
    const refreshAlert = vi.fn(async () => ({ state: 'posted', count: 1 }));
    app.use('/api', createSubscriptionRouter({ adminToken: 'admin-token', syncFromSheet, refreshAlert }));

    const update = await request(app).post('/api/subscriptions/update').set('Authorization', 'Bearer admin-token');
    const alert = await request(app).post('/api/subscriptions/send-alert').set('Authorization', 'Bearer admin-token');

    expect(update.body).toEqual({
      subscriptions: { updatedUsers: 2 },
      alert: { state: 'posted', count: 1 }
    });
    expect(alert.body).toEqual({ alert: { state: 'posted', count: 1 } });
    expect(syncFromSheet).toHaveBeenCalledTimes(1);
    expect(refreshAlert).toHaveBeenCalledTimes(2);
    expect(syncFromSheet.mock.invocationCallOrder[0]).toBeLessThan(refreshAlert.mock.invocationCallOrder[0]);
  });

  it('passes action errors to the express error handler', async () => {
    const app = express();
    app.use('/api', createSubscriptionRouter({
      adminToken: 'admin-token',
      syncFromSheet: vi.fn(async () => {
        throw new Error('sheet unavailable');
      }),
      refreshAlert: vi.fn()
    }));
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(503).json({ error: error instanceof Error ? error.message : 'unknown' });
    });

    await expect(
      request(app).post('/api/subscriptions/update').set('Authorization', 'Bearer admin-token')
    ).resolves.toMatchObject({
      status: 503,
      body: { error: 'sheet unavailable' }
    });
  });
});
