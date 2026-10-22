import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Config } from './config/env.js';
import type { Database } from './db/client.js';
import { errorHandler, notFoundHandler } from './errors.js';
import type { EventPublisher } from './events/publisher.js';
import { healthRouter } from './routes/health.routes.js';
import { REQUESTS_PREFIX, requestsRouter } from './routes/requests.routes.js';

const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[\w.-]{1,128}$/;
const BODY_LIMIT = '10kb';

export interface AppDependencies {
  config: Config;
  db: Database;
  events: EventPublisher;
}

/** Builds the Express app without listening, so tests can drive it with Supertest. */
export function buildApp({ config, db, events }: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  // The service never uses the client IP; ignore X-Forwarded-* rather than trust them implicitly.
  app.set('trust proxy', false);

  app.use(
    pinoHttp({
      logger: pino({
        level: config.LOG_LEVEL,
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      }),
      // Reuse the gateway's request ID for log correlation, if it is safe.
      genReqId: (req, res) => {
        const incoming = req.headers[REQUEST_ID_HEADER];
        const id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader(REQUEST_ID_HEADER, id);
        return id;
      },
    }),
  );
  app.use(helmet());
  // An empty list disables CORS entirely; browsers are expected to come through the gateway.
  app.use(cors({ origin: config.CORS_ORIGIN }));
  app.use(express.json({ limit: BODY_LIMIT }));

  app.use(healthRouter());
  app.use(REQUESTS_PREFIX, requestsRouter(config, db, events));

  app.use(notFoundHandler);
  app.use(errorHandler(config));

  return app;
}
