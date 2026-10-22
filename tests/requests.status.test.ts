import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { requests, type RequestStatus } from '../src/db/schema.js';
import { fakePublisher, newUser, testConfig } from './helpers/app.js';
import { createTestDb, resetDatabase } from './helpers/test-db.js';

const { db, pool } = createTestDb();
const app = buildApp({ config: testConfig(), db, events: fakePublisher() });

let alice: { id: string; token: string };

beforeEach(async () => {
  await resetDatabase(db);
  alice = await newUser();
});
afterAll(() => pool.end());

async function seed(status: RequestStatus, userId = alice.id) {
  const past = new Date(Date.now() - 60_000);
  const [row] = await db.insert(requests).values({ userId, title: 'Renew ID card', status, createdAt: past, updatedAt: past }).returning();
  return row!;
}

const patch = (id: string, body: object, token = alice.token) =>
  request(app).patch(`/requests/${id}/status`).auth(token, { type: 'bearer' }).send(body);

async function statusOf(id: string) {
  const [row] = await db.select().from(requests).where(eq(requests.id, id));
  return row!.status;
}

describe('PATCH /requests/:id/status', () => {
  it.each([
    ['PENDING', 'IN_PROGRESS'],
    ['PENDING', 'CANCELLED'],
    ['IN_PROGRESS', 'COMPLETED'],
    ['IN_PROGRESS', 'CANCELLED'],
  ] as const)('allows %s -> %s and bumps updatedAt', async (from, to) => {
    const row = await seed(from);
    const res = await patch(row.id, { status: to });

    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ id: row.id, status: to, createdAt: row.createdAt.toISOString() });
    expect(Date.parse(res.body.request.updatedAt)).toBeGreaterThan(row.updatedAt.getTime());
    expect(await statusOf(row.id)).toBe(to);
  });

  it.each([
    ['PENDING', 'COMPLETED'],
    ['PENDING', 'PENDING'],
    ['IN_PROGRESS', 'PENDING'],
    ['IN_PROGRESS', 'IN_PROGRESS'],
    ['COMPLETED', 'CANCELLED'],
    ['COMPLETED', 'IN_PROGRESS'],
    ['CANCELLED', 'PENDING'],
    ['CANCELLED', 'IN_PROGRESS'],
  ] as const)('rejects %s -> %s with 409 and leaves the row unchanged', async (from, to) => {
    const row = await seed(from);
    const res = await patch(row.id, { status: to });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
      message: `Cannot change status from ${from} to ${to}`,
    });
    expect(await statusOf(row.id)).toBe(from);
  });

  // Both targets are terminal, so whichever commits second must be rejected
  // (IN_PROGRESS -> CANCELLED alone would be legal after either order).
  it('lets exactly one of two concurrent conflicting transitions win', async () => {
    const row = await seed('IN_PROGRESS');
    const results = await Promise.all([patch(row.id, { status: 'COMPLETED' }), patch(row.id, { status: 'CANCELLED' })]);

    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const winner = results.find((res) => res.status === 200)!;
    expect(await statusOf(row.id)).toBe(winner.body.request.status);
  });

  it('applies a repeated transition only once under concurrency', async () => {
    const row = await seed('PENDING');
    const results = await Promise.all(Array.from({ length: 5 }, () => patch(row.id, { status: 'IN_PROGRESS' })));

    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(results.filter((res) => res.status === 409)).toHaveLength(4);
  });

  it("returns 404 for another user's request and does not change it", async () => {
    const bob = await newUser();
    const bobs = await seed('PENDING', bob.id);

    const res = await patch(bobs.id, { status: 'CANCELLED' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('REQUEST_NOT_FOUND');
    expect(await statusOf(bobs.id)).toBe('PENDING');
  });

  it('returns 404 for a request that does not exist', async () => {
    const res = await patch(randomUUID(), { status: 'CANCELLED' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('REQUEST_NOT_FOUND');
  });

  it.each([
    ['an unknown status', { status: 'DONE' }],
    ['a missing status', {}],
    ['extra fields', { status: 'CANCELLED', title: 'changed' }],
  ])('rejects %s with 400', async (_case, body) => {
    const row = await seed('PENDING');
    const res = await patch(row.id, body);
    expect(res.status).toBe(400);
    expect(await statusOf(row.id)).toBe('PENDING');
  });

  it('rejects a non-UUID id with 400', async () => {
    const res = await patch('not-a-uuid', { status: 'CANCELLED' });
    expect(res.status).toBe(400);
  });
});
