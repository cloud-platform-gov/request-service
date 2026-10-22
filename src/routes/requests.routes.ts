import { Router, type RequestHandler } from 'express';
import type { Config } from '../config/env.js';
import type { Database } from '../db/client.js';
import { HttpError } from '../errors.js';
import type { EventPublisher } from '../events/publisher.js';
import { requestCreatedEvent } from '../events/request-created.js';
import { authenticate } from '../middlewares/authenticate.js';
import { createRequest, findRequestForUser, listRequestsForUser, transitionStatus } from '../modules/requests/requests.js';
import {
  createRequestSchema,
  listQuerySchema,
  requestIdParamsSchema,
  updateStatusSchema,
} from '../modules/requests/schemas.js';

/**
 * Mounted at `/requests`: the API Gateway strips `/api/v1`, so the public
 * `/api/v1/requests/:id` arrives here as `/requests/:id`.
 */
export const REQUESTS_PREFIX = '/requests';

const requireJson: RequestHandler = (req, _res, next) => {
  if (!req.is('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }
  next();
};

// Used for both "does not exist" and "belongs to someone else", so existence never leaks.
const requestNotFound = () => new HttpError(404, 'REQUEST_NOT_FOUND', 'Request not found');

export function requestsRouter(config: Config, db: Database, events: EventPublisher): Router {
  const router = Router();
  router.use(authenticate(config));

  router.post('/', requireJson, async (req, res) => {
    const input = createRequestSchema.parse(req.body);
    const request = await createRequest(db, { userId: res.locals.userId!, ...input });

    // Not atomic with the insert (see README, "Delivery guarantees"): the request
    // is committed either way, so a failed publish is reported, not turned into a 5xx.
    const event = requestCreatedEvent(request);
    let eventPublished = true;
    try {
      await events.publish(event);
    } catch (err) {
      eventPublished = false;
      req.log.error({ err, requestId: request.id, eventId: event.eventId }, 'failed to publish request.created.v1');
    }

    res.status(201).json({ request, eventPublished });
  });

  router.get('/', async (req, res) => {
    const page = listQuerySchema.parse(req.query);
    const { items, total } = await listRequestsForUser(db, res.locals.userId!, page);
    res.json({ requests: items, pagination: { ...page, total } });
  });

  router.get('/:id', async (req, res) => {
    const { id } = requestIdParamsSchema.parse(req.params);
    const request = await findRequestForUser(db, id, res.locals.userId!);
    if (!request) throw requestNotFound();
    res.json({ request });
  });

  router.patch('/:id/status', requireJson, async (req, res) => {
    const { id } = requestIdParamsSchema.parse(req.params);
    const { status } = updateStatusSchema.parse(req.body);
    const result = await transitionStatus(db, id, res.locals.userId!, status);
    if (result.outcome === 'not_found') throw requestNotFound();
    if (result.outcome === 'invalid') {
      throw new HttpError(
        409,
        'INVALID_STATUS_TRANSITION',
        `Cannot change status from ${result.current} to ${status}`,
      );
    }
    res.json({ request: result.request });
  });

  return router;
}
