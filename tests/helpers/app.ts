import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { loadConfig, type Config } from '../../src/config/env.js';
import { EventPublishError, type DomainEvent, type EventPublisher } from '../../src/events/publisher.js';

export const TEST_SECRET = 'test-secret-that-is-long-enough-for-hs256-and-hs512-keys-0123456789';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://unused@localhost:5432/unused',
    JWT_SECRET: TEST_SECRET,
    JWT_ISSUER: 'test-issuer',
    RABBITMQ_URL: 'amqp://unused:unused@localhost:5672',
    ...overrides,
  });
}

/** Signs a token the way the Identity Service does (HS256; sub, iss, iat, exp only). */
export function tokenFor(
  userId: string,
  { secret = TEST_SECRET, issuer = 'test-issuer', issuedAt = new Date(), ttlSeconds = 900 } = {},
): Promise<string> {
  const iat = Math.floor(issuedAt.getTime() / 1000);
  return new SignJWT()
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(issuer)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSeconds)
    .sign(new TextEncoder().encode(secret));
}

/** In-memory stand-in for RabbitMQ: records published events, or fails like an unreachable broker. */
export function fakePublisher() {
  const published: DomainEvent[] = [];
  let failing = false;
  const publisher: EventPublisher & { published: DomainEvent[]; fail(value?: boolean): void } = {
    published,
    fail(value = true) {
      failing = value;
    },
    async publish(event) {
      if (failing) throw new EventPublishError({ cause: new Error('connect ECONNREFUSED 127.0.0.1:5672') });
      published.push(event);
    },
    async close() {},
  };
  return publisher;
}

export async function newUser(): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  return { id, token: await tokenFor(id) };
}
