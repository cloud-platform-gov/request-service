import { randomUUID } from 'node:crypto';
import type { Request } from '../db/schema.js';

export const REQUEST_CREATED_V1 = 'request.created.v1';

/**
 * Public contract of `request.created.v1` (see README, "Events"). Changes must
 * be additive; anything breaking needs a new `request.created.v2` event type.
 */
export interface RequestCreatedV1 {
  eventId: string;
  eventType: typeof REQUEST_CREATED_V1;
  eventVersion: 1;
  occurredAt: string;
  requestId: string;
  userId: string;
  title: string;
}

export function requestCreatedEvent(request: Request): RequestCreatedV1 {
  return {
    eventId: randomUUID(),
    eventType: REQUEST_CREATED_V1,
    eventVersion: 1,
    occurredAt: request.createdAt.toISOString(),
    requestId: request.id,
    userId: request.userId,
    title: request.title,
  };
}
