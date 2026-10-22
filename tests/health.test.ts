import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { fakePublisher, testConfig } from './helpers/app.js';
import { createTestDb } from './helpers/test-db.js';

const { db, pool } = createTestDb();
const app = buildApp({ config: testConfig(), db, events: fakePublisher() });

afterAll(() => pool.end());

describe('GET /health', () => {
  it('returns 200 without authentication', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'request-service' });
  });

  it('propagates a safe x-request-id and generates one otherwise', async () => {
    const propagated = await request(app).get('/health').set('x-request-id', 'gateway-abc.123');
    expect(propagated.headers['x-request-id']).toBe('gateway-abc.123');

    const generated = await request(app).get('/health').set('x-request-id', 'bad id<script>');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('does not allow cross-origin requests unless configured', async () => {
    const denied = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    const allowedApp = buildApp({ config: testConfig({ CORS_ORIGIN: 'http://localhost:5173' }), db, events: fakePublisher() });
    const allowed = await request(allowedApp).get('/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
