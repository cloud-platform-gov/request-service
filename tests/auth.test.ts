import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { fakePublisher, newUser, TEST_SECRET, testConfig, tokenFor } from './helpers/app.js';
import { createTestDb, resetDatabase } from './helpers/test-db.js';

const { db, pool } = createTestDb();
const app = buildApp({ config: testConfig(), db, events: fakePublisher() });
const key = new TextEncoder().encode(TEST_SECRET);
const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

beforeEach(() => resetDatabase(db));
afterAll(() => pool.end());

function expectUnauthorized(res: request.Response) {
  expect(res.status).toBe(401);
  expect(res.body.error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Authentication required' });
}

const routes = [
  ['POST', '/requests'],
  ['GET', '/requests'],
  ['GET', `/requests/${randomUUID()}`],
  ['PATCH', `/requests/${randomUUID()}/status`],
] as const;

function call(method: string, path: string) {
  const req = request(app);
  return method === 'POST' ? req.post(path) : method === 'PATCH' ? req.patch(path) : req.get(path);
}

describe('authentication', () => {
  it.each(routes)('%s %s requires a bearer token', async (method, path) => {
    expectUnauthorized(await call(method, path));
  });

  it('rejects a non-Bearer scheme and a malformed token', async () => {
    const { token } = await newUser();
    expectUnauthorized(await request(app).get('/requests').set('Authorization', `Basic ${token}`));
    expectUnauthorized(await request(app).get('/requests').auth('not.a.jwt', { type: 'bearer' }));
  });

  it('rejects a token signed with another secret', async () => {
    const forged = await tokenFor(randomUUID(), { secret: 'another-secret-that-is-also-32-bytes-long' });
    expectUnauthorized(await request(app).get('/requests').auth(forged, { type: 'bearer' }));
  });

  it('rejects a token from another issuer', async () => {
    const foreign = await tokenFor(randomUUID(), { issuer: 'someone-else' });
    expectUnauthorized(await request(app).get('/requests').auth(foreign, { type: 'bearer' }));
  });

  it('rejects an expired token', async () => {
    const expired = await tokenFor(randomUUID(), { issuedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });
    expectUnauthorized(await request(app).get('/requests').auth(expired, { type: 'bearer' }));
  });

  it('rejects other algorithms, even with the right secret', async () => {
    const userId = randomUUID();
    const hs512 = await new SignJWT()
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject(userId)
      .setIssuer('test-issuer')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
    expectUnauthorized(await request(app).get('/requests').auth(hs512, { type: 'bearer' }));

    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url({ alg: 'none' })}.${base64url({ sub: userId, iss: 'test-issuer', iat: now, exp: now + 300 })}.`;
    expectUnauthorized(await request(app).get('/requests').auth(unsigned, { type: 'bearer' }));
  });

  it('rejects a token without exp or with a non-UUID subject', async () => {
    const noExp = await new SignJWT()
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(randomUUID())
      .setIssuer('test-issuer')
      .setIssuedAt()
      .sign(key);
    expectUnauthorized(await request(app).get('/requests').auth(noExp, { type: 'bearer' }));

    const badSubject = await tokenFor('admin');
    expectUnauthorized(await request(app).get('/requests').auth(badSubject, { type: 'bearer' }));
  });

  it('ignores identity headers: only the verified token decides who the caller is', async () => {
    const alice = await newUser();
    const bob = await newUser();
    await request(app).post('/requests').auth(bob.token, { type: 'bearer' }).send({ title: 'Bob only' }).expect(201);

    expectUnauthorized(await request(app).get('/requests').set('x-user-id', bob.id));

    const res = await request(app)
      .get('/requests')
      .auth(alice.token, { type: 'bearer' })
      .set('x-user-id', bob.id)
      .set('x-forwarded-user', bob.id);
    expect(res.status).toBe(200);
    expect(res.body.requests).toEqual([]);
  });
});
