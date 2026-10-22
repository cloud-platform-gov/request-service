import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { requests } from '../src/db/schema.js';
import { fakePublisher, newUser, testConfig } from './helpers/app.js';
import { createTestDb, resetDatabase } from './helpers/test-db.js';

const { db, pool } = createTestDb();
const app = buildApp({ config: testConfig(), db, events: fakePublisher() });

let alice: { id: string; token: string };
let bob: { id: string; token: string };

beforeEach(async () => {
  await resetDatabase(db);
  alice = await newUser();
  bob = await newUser();
});
afterAll(() => pool.end());

/** Inserts `count` requests for `userId`, one minute apart, so ordering is deterministic. */
async function seed(userId: string, count: number) {
  const base = Date.parse('2026-01-01T00:00:00Z');
  return db
    .insert(requests)
    .values(Array.from({ length: count }, (_, i) => ({ userId, title: `Request ${i + 1}`, createdAt: new Date(base + i * 60_000) })))
    .returning();
}

describe('GET /requests/:id', () => {
  it("returns the caller's own request", async () => {
    const [own] = await seed(alice.id, 1);
    const res = await request(app).get(`/requests/${own!.id}`).auth(alice.token, { type: 'bearer' });
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ id: own!.id, userId: alice.id, title: 'Request 1' });
  });

  it("answers another user's request exactly like a missing one", async () => {
    const [bobs] = await seed(bob.id, 1);
    const foreign = await request(app).get(`/requests/${bobs!.id}`).auth(alice.token, { type: 'bearer' });
    const missing = await request(app).get(`/requests/${randomUUID()}`).auth(alice.token, { type: 'bearer' });

    for (const res of [foreign, missing]) {
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({ code: 'REQUEST_NOT_FOUND', message: 'Request not found' });
    }
    expect(JSON.stringify(foreign.body)).not.toContain(bob.id);
  });

  it('rejects an id that is not a UUID', async () => {
    const res = await request(app).get('/requests/123').auth(alice.token, { type: 'bearer' });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([expect.objectContaining({ path: 'id' })]);
  });
});

describe('GET /requests', () => {
  it("lists only the caller's requests, newest first, with default pagination", async () => {
    await seed(alice.id, 3);
    await seed(bob.id, 2);

    const res = await request(app).get('/requests').auth(alice.token, { type: 'bearer' });
    expect(res.status).toBe(200);
    expect(res.body.requests.map((r: { title: string }) => r.title)).toEqual(['Request 3', 'Request 2', 'Request 1']);
    expect(res.body.requests.every((r: { userId: string }) => r.userId === alice.id)).toBe(true);
    expect(res.body.pagination).toEqual({ limit: 20, offset: 0, total: 3 });
  });

  it('pages with limit and offset and reports the total', async () => {
    await seed(alice.id, 5);

    const page = await request(app).get('/requests?limit=2&offset=2').auth(alice.token, { type: 'bearer' });
    expect(page.body.requests.map((r: { title: string }) => r.title)).toEqual(['Request 3', 'Request 2']);
    expect(page.body.pagination).toEqual({ limit: 2, offset: 2, total: 5 });

    const beyond = await request(app).get('/requests?offset=10').auth(alice.token, { type: 'bearer' });
    expect(beyond.body.requests).toEqual([]);
    expect(beyond.body.pagination.total).toBe(5);
  });

  it('returns an empty list for a user with no requests', async () => {
    const res = await request(app).get('/requests').auth(alice.token, { type: 'bearer' });
    expect(res.body).toEqual({ requests: [], pagination: { limit: 20, offset: 0, total: 0 } });
  });

  it.each(['limit=0', 'limit=101', 'limit=abc', 'limit=1.5', 'offset=-1'])('rejects %s with 400', async (query) => {
    const res = await request(app).get(`/requests?${query}`).auth(alice.token, { type: 'bearer' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('ignores a userId in the query string', async () => {
    await seed(bob.id, 1);
    const res = await request(app).get(`/requests?userId=${bob.id}`).auth(alice.token, { type: 'bearer' });
    expect(res.status).toBe(200);
    expect(res.body.requests).toEqual([]);
  });
});
