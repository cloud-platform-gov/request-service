import { EventEmitter } from 'node:events';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Confirm = 'ack' | 'nack' | 'hang';

class FakeChannel extends EventEmitter {
  confirm: Confirm = 'ack';
  assertExchange = vi.fn(async () => ({ exchange: 'x' }));
  publish = vi.fn((_exchange: string, _key: string, _content: Buffer, _options: object, cb: (err: unknown) => void) => {
    if (this.confirm === 'ack') queueMicrotask(() => cb(null));
    if (this.confirm === 'nack') queueMicrotask(() => cb(new Error('message nacked')));
    return true;
  });
  close = vi.fn(async () => {});
}

class FakeConnection extends EventEmitter {
  channel = new FakeChannel();
  createConfirmChannel = vi.fn(async () => this.channel);
  close = vi.fn(async () => {
    this.emit('close');
  });
}

const broker = vi.hoisted(() => ({ connections: [] as unknown[], refuse: false }));

vi.mock('amqplib', () => ({
  default: {
    connect: vi.fn(async () => {
      if (broker.refuse) throw new Error('connect ECONNREFUSED 10.0.0.5:5672');
      const conn = new FakeConnection();
      broker.connections.push(conn);
      return conn;
    }),
  },
}));

const { default: amqp } = await import('amqplib');
const { createAmqpPublisher, EventPublishError } = await import('../src/events/publisher.js');

const config = {
  RABBITMQ_URL: 'amqp://user:s3cret-pass@broker.internal:5672',
  RABBITMQ_EXCHANGE: 'test.events',
  RABBITMQ_PUBLISH_TIMEOUT_MS: 50,
};
const logger = pino({ level: 'silent' });
const event = {
  eventId: '6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c',
  eventType: 'request.created.v1',
  occurredAt: '2026-01-01T00:00:00.000Z',
  title: 'Renew ID card',
};

const connections = () => broker.connections as FakeConnection[];

beforeEach(() => {
  broker.connections.length = 0;
  broker.refuse = false;
  vi.mocked(amqp.connect).mockClear();
});
afterEach(() => vi.useRealTimers());

async function expectPublishError(promise: Promise<unknown>) {
  const err = await promise.then(
    () => expect.unreachable('publish should have failed'),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EventPublishError);
  expect((err as Error).message).toBe('Event could not be published');
  expect((err as Error).message).not.toMatch(/s3cret|broker\.internal|5672/);
  return err as Error;
}

describe('createAmqpPublisher', () => {
  it('connects lazily and declares a durable topic exchange', async () => {
    const publisher = createAmqpPublisher(config, logger);
    expect(amqp.connect).not.toHaveBeenCalled();

    await publisher.publish(event);
    expect(amqp.connect).toHaveBeenCalledWith(config.RABBITMQ_URL, expect.objectContaining({ timeout: 50 }));
    expect(connections()[0]!.channel.assertExchange).toHaveBeenCalledWith('test.events', 'topic', { durable: true });
  });

  it('publishes a persistent JSON message routed by event type and resolves on confirm', async () => {
    const publisher = createAmqpPublisher(config, logger);
    await publisher.publish(event);

    const [exchange, routingKey, content, options] = connections()[0]!.channel.publish.mock.calls[0]!;
    expect(exchange).toBe('test.events');
    expect(routingKey).toBe('request.created.v1');
    expect(JSON.parse(content.toString('utf8'))).toEqual(event);
    expect(options).toEqual({
      persistent: true,
      contentType: 'application/json',
      contentEncoding: 'utf-8',
      messageId: event.eventId,
      type: 'request.created.v1',
      timestamp: Date.parse(event.occurredAt) / 1000,
      appId: 'request-service',
    });
  });

  it('reuses one connection and channel across publishes', async () => {
    const publisher = createAmqpPublisher(config, logger);
    await publisher.publish(event);
    await publisher.publish(event);
    expect(amqp.connect).toHaveBeenCalledTimes(1);
    expect(connections()[0]!.channel.publish).toHaveBeenCalledTimes(2);
  });

  it('rejects with a generic error when the broker is unreachable, and retries on the next publish', async () => {
    broker.refuse = true;
    const publisher = createAmqpPublisher(config, logger);
    const err = await expectPublishError(publisher.publish(event));
    expect((err.cause as Error).message).toMatch(/ECONNREFUSED/);

    broker.refuse = false;
    await publisher.publish(event);
    expect(amqp.connect).toHaveBeenCalledTimes(2);
  });

  it('rejects when the broker nacks the message', async () => {
    const publisher = createAmqpPublisher(config, logger);
    await publisher.publish(event);
    connections()[0]!.channel.confirm = 'nack';
    await expectPublishError(publisher.publish(event));
  });

  it('rejects when no confirm arrives in time, and drops that connection', async () => {
    const publisher = createAmqpPublisher(config, logger);
    await publisher.publish(event);
    const first = connections()[0]!;
    first.channel.confirm = 'hang';

    await expectPublishError(publisher.publish(event));
    expect(first.close).toHaveBeenCalled();

    await publisher.publish(event);
    expect(amqp.connect).toHaveBeenCalledTimes(2);
  });

  it('reconnects after the broker closes the connection', async () => {
    const publisher = createAmqpPublisher(config, logger);
    await publisher.publish(event);
    connections()[0]!.emit('close', new Error('CONNECTION_FORCED'));

    await publisher.publish(event);
    expect(amqp.connect).toHaveBeenCalledTimes(2);
  });

  it('survives connection error events instead of crashing the process', async () => {
    const publisher = createAmqpPublisher(config, logger);
    await publisher.publish(event);
    expect(() => connections()[0]!.emit('error', new Error('boom'))).not.toThrow();
    expect(() => connections()[0]!.channel.emit('error', new Error('boom'))).not.toThrow();
  });

  it('closes the connection once and refuses to publish afterwards', async () => {
    const publisher = createAmqpPublisher(config, logger);
    await publisher.publish(event);
    await publisher.close();
    await publisher.close();

    expect(connections()[0]!.close).toHaveBeenCalledTimes(1);
    await expectPublishError(publisher.publish(event));
    expect(amqp.connect).toHaveBeenCalledTimes(1);
  });

  it('closing before any publish does not connect', async () => {
    const publisher = createAmqpPublisher(config, logger);
    await publisher.close();
    expect(amqp.connect).not.toHaveBeenCalled();
  });
});
