import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { fakePublisher, newUser, testConfig } from './helpers/app.js';

// Port 1 is closed, so every query fails to connect: a real database outage, not a mock.
const { db, pool } = createDb('postgres://requests:requests@127.0.0.1:1/requests_test', {
  connectionTimeoutMillis: 1_000,
});

afterAll(() => pool.end());

describe('error handling', () => {
  it('returns a generic 500 in production when the database is unavailable', async () => {
    const events = fakePublisher();
    const app = buildApp({ config: testConfig({ NODE_ENV: 'production' }), db, events });
    const { token } = await newUser();

    const calls = [
      request(app).post('/requests').auth(token, { type: 'bearer' }).send({ title: 'Renew ID card' }),
      request(app).get('/requests').auth(token, { type: 'bearer' }),
      request(app).get('/requests/0b5c9d0e-4f8a-4c1e-9a1b-2f3d4e5f6a7b').auth(token, { type: 'bearer' }),
      request(app)
        .patch('/requests/0b5c9d0e-4f8a-4c1e-9a1b-2f3d4e5f6a7b/status')
        .auth(token, { type: 'bearer' })
        .send({ status: 'CANCELLED' }),
    ];
    for (const call of calls) {
      const res = await call;
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: expect.any(String) },
      });
      expect(res.text).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|stack|at /);
    }
    // Nothing was stored, so nothing may be announced.
    expect(events.published).toHaveLength(0);
  });

  it('returns 404 in the common error format for unknown routes', async () => {
    const app = buildApp({ config: testConfig(), db, events: fakePublisher() });
    // The gateway strips /api/v1, so the public path is unknown to the service itself.
    const res = await request(app).get('/api/v1/requests');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', requestId: expect.any(String) });
  });
});
