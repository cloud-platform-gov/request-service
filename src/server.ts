import { pino } from 'pino';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { createDb } from './db/client.js';
import { createAmqpPublisher } from './events/publisher.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // The pool and the broker connection are both opened lazily; migrations are
  // applied separately (`npm run db:migrate`).
  const { db, pool } = createDb(config.DATABASE_URL);
  const events = createAmqpPublisher(config, pino({ level: config.LOG_LEVEL }).child({ component: 'events' }));
  const app = buildApp({ config, db, events });

  const server = app.listen(config.PORT, config.HOST, (err) => {
    if (err) {
      console.error('Failed to start request-service:', err.message);
      process.exit(1);
    }
    console.log(`request-service listening on http://${config.HOST}:${config.PORT}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    const forceExit = setTimeout(() => {
      console.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    // In-flight requests finish (and publish) before the broker and pool are closed.
    server.close(() => {
      events
        .close()
        .then(() => pool.end())
        .then(
          () => process.exit(0),
          (err: unknown) => {
            console.error('error during shutdown:', err);
            process.exit(1);
          },
        );
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
