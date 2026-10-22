import type { RequestStatus } from '../../db/schema.js';

/**
 * The only permitted transitions. COMPLETED and CANCELLED are terminal, and
 * nothing moves back to PENDING.
 *
 *   PENDING     -> IN_PROGRESS | CANCELLED
 *   IN_PROGRESS -> COMPLETED   | CANCELLED
 */
export const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  PENDING: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

/** The statuses a request may be in for a move to `target` to be allowed. */
export function allowedSources(target: RequestStatus): RequestStatus[] {
  return (Object.keys(TRANSITIONS) as RequestStatus[]).filter((from) => TRANSITIONS[from].includes(target));
}
