import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import type { Logger } from 'pino';
import type { Config } from '../config/env.js';

/** Every event carries these; `eventType` doubles as the routing key. */
export interface DomainEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
}

export interface EventPublisher {
  /** Resolves only once the broker has confirmed the message; rejects with `EventPublishError` otherwise. */
  publish(event: DomainEvent): Promise<void>;
  close(): Promise<void>;
}

/** Deliberately generic: the cause (kept for logs only) may name the broker host. */
export class EventPublishError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Event could not be published', options);
    this.name = 'EventPublishError';
  }
}

const APP_ID = 'request-service';

type PublisherConfig = Pick<Config, 'RABBITMQ_URL' | 'RABBITMQ_EXCHANGE' | 'RABBITMQ_PUBLISH_TIMEOUT_MS'>;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Publishes persistent JSON messages to a durable topic exchange over a confirm
 * channel. The connection is opened on first use and dropped on any error or
 * close, so the next publish reconnects; a broker that is down at startup does
 * not stop the service. No queues are declared here: consumers own their queues
 * and bindings.
 */
export function createAmqpPublisher(config: PublisherConfig, logger: Logger): EventPublisher {
  let connection: ChannelModel | undefined;
  let channel: Promise<ConfirmChannel> | undefined;
  let closed = false;

  function discard(conn: ChannelModel): void {
    if (connection !== conn) return;
    connection = undefined;
    channel = undefined;
    conn.close().catch(() => {});
  }

  async function open(): Promise<ConfirmChannel> {
    const conn = await amqp.connect(config.RABBITMQ_URL, {
      timeout: config.RABBITMQ_PUBLISH_TIMEOUT_MS,
      clientProperties: { connection_name: APP_ID },
    });
    connection = conn;
    // Without an 'error' listener, a broker-side error would crash the process.
    conn.on('error', (err: Error) => logger.warn({ err }, 'rabbitmq connection error'));
    conn.on('close', () => discard(conn));
    try {
      const ch = await conn.createConfirmChannel();
      ch.on('error', (err: Error) => logger.warn({ err }, 'rabbitmq channel error'));
      ch.on('close', () => discard(conn));
      await ch.assertExchange(config.RABBITMQ_EXCHANGE, 'topic', { durable: true });
      if (closed) throw new Error('publisher closed');
      return ch;
    } catch (err) {
      discard(conn);
      throw err;
    }
  }

  function getChannel(): Promise<ConfirmChannel> {
    channel ??= open().catch((err: unknown) => {
      channel = undefined;
      throw err;
    });
    return channel;
  }

  return {
    async publish(event) {
      if (closed) throw new EventPublishError({ cause: new Error('publisher closed') });
      try {
        const ch = await getChannel();
        const confirmed = new Promise<void>((resolve, reject) => {
          ch.publish(
            config.RABBITMQ_EXCHANGE,
            event.eventType,
            Buffer.from(JSON.stringify(event)),
            {
              persistent: true,
              contentType: 'application/json',
              contentEncoding: 'utf-8',
              messageId: event.eventId,
              type: event.eventType,
              timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
              appId: APP_ID,
            },
            // Called with an error when the broker nacks or the channel closes first.
            (err: unknown) => (err ? reject(err instanceof Error ? err : new Error('message nacked')) : resolve()),
          );
        });
        try {
          await withTimeout(confirmed, config.RABBITMQ_PUBLISH_TIMEOUT_MS, 'publisher confirm');
        } catch (err) {
          // A channel that does not confirm in time is not trusted for the next message.
          if (connection) discard(connection);
          throw err;
        }
      } catch (err) {
        throw new EventPublishError({ cause: err });
      }
    },

    async close() {
      closed = true;
      const conn = connection;
      connection = undefined;
      channel = undefined;
      await conn?.close().catch(() => {});
    },
  };
}
