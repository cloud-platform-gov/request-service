import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { requests } from '../src/db/schema.js';
import { fakePublisher, newUser, testConfig } from './helpers/app.js';
import { createTestDb, resetDatabase } from './helpers/test-db.js';

const { db, pool } = createTestDb();
const events = fakePublisher();
const app = buildApp({ config: testConfig(), db, events });

let user: { id: string; token: string };

beforeEach(async () => {
  await resetDatabase(db);
  events.published.length = 0;
  events.fail(false);
  user = await newUser();
});
afterAll(() => pool.end());

const post = (body: unknown) => request(app).post('/requests').auth(user.token, { type: 'bearer' }).send(body as object);

describe('POST /requests', () => {
  it('creates a PENDING request owned by the token subject', async () => {
    const res = await post({ title: '  Renew ID card  ', description: 'Lost my old one' });

    expect(res.status).toBe(201);
    expect(res.body.eventPublished).toBe(true);
    expect(res.body.request).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      userId: user.id,
      title: 'Renew ID card',
      description: 'Lost my old one',
      status: 'PENDING',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const [row] = await db.select().from(requests).where(eq(requests.id, res.body.request.id));
    expect(row).toMatchObject({ userId: user.id, title: 'Renew ID card', status: 'PENDING' });
  });

  it('stores a missing or blank description as null', async () => {
    expect((await post({ title: 'A' })).body.request.description).toBeNull();
    expect((await post({ title: 'B', description: '   ' })).body.request.description).toBeNull();
    expect((await post({ title: 'C', description: null })).body.request.description).toBeNull();
  });

  it('publishes one request.created.v1 event with the documented payload', async () => {
    const res = await post({ title: 'Renew ID card' });

    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toEqual({
      eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      eventType: 'request.created.v1',
      eventVersion: 1,
      occurredAt: res.body.request.createdAt,
      requestId: res.body.request.id,
      userId: user.id,
      title: 'Renew ID card',
    });
  });

  it('still returns 201, and says so, when the event cannot be published', async () => {
    events.fail();
    const res = await post({ title: 'Renew ID card' });

    expect(res.status).toBe(201);
    expect(res.body.eventPublished).toBe(false);
    expect(res.text).not.toMatch(/ECONNREFUSED|5672|amqp/);
    const rows = await db.select().from(requests).where(eq(requests.id, res.body.request.id));
    expect(rows).toHaveLength(1);
  });

  it.each([
    ['missing title', {}],
    ['blank title', { title: '   ' }],
    ['title over 200 characters', { title: 'x'.repeat(201) }],
    ['non-string title', { title: 42 }],
    ['description over 2000 characters', { title: 'ok', description: 'x'.repeat(2001) }],
    ['a client-supplied userId', { title: 'ok', userId: '00000000-0000-4000-8000-000000000000' }],
    ['a client-supplied status', { title: 'ok', status: 'COMPLETED' }],
  ])('rejects %s with 400 and publishes nothing', async (_case, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST', requestId: expect.any(String) });
    expect(events.published).toHaveLength(0);
    expect(await db.select().from(requests)).toHaveLength(0);
  });

  it('returns field-level details for validation errors', async () => {
    const res = await post({ title: '' });
    expect(res.body.error.details).toEqual([expect.objectContaining({ path: 'title' })]);
  });

  it('rejects malformed JSON and non-JSON bodies', async () => {
    const malformed = await request(app)
      .post('/requests')
      .auth(user.token, { type: 'bearer' })
      .set('Content-Type', 'application/json')
      .send('{"title":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.message).toBe('Malformed JSON body');

    const form = await request(app).post('/requests').auth(user.token, { type: 'bearer' }).type('form').send('title=x');
    expect(form.status).toBe(415);
    expect(form.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});
