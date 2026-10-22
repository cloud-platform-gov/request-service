import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { requests, type Request, type RequestStatus } from '../../db/schema.js';
import { allowedSources } from './status.js';

export async function createRequest(
  db: Database,
  values: { userId: string; title: string; description: string | null },
): Promise<Request> {
  const [request] = await db.insert(requests).values(values).returning();
  if (!request) throw new Error('insert returned no row');
  return request;
}

/** Ownership is part of the lookup, so another user's request is indistinguishable from a missing one. */
export async function findRequestForUser(db: Database, id: string, userId: string): Promise<Request | undefined> {
  const [request] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.id, id), eq(requests.userId, userId)))
    .limit(1);
  return request;
}

export async function listRequestsForUser(
  db: Database,
  userId: string,
  page: { limit: number; offset: number },
): Promise<{ items: Request[]; total: number }> {
  const owned = eq(requests.userId, userId);
  const [items, [totals]] = await Promise.all([
    db
      .select()
      .from(requests)
      .where(owned)
      .orderBy(desc(requests.createdAt), desc(requests.id))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ total: count() }).from(requests).where(owned),
  ]);
  return { items, total: totals?.total ?? 0 };
}

export type TransitionResult =
  | { outcome: 'updated'; request: Request }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; current: RequestStatus };

/**
 * The allowed source statuses are part of the UPDATE's WHERE clause, so the
 * check and the write are one atomic statement: of two concurrent updates from
 * the same status, only one can match.
 */
export async function transitionStatus(
  db: Database,
  id: string,
  userId: string,
  to: RequestStatus,
): Promise<TransitionResult> {
  const sources = allowedSources(to);
  if (sources.length > 0) {
    const [updated] = await db
      .update(requests)
      .set({ status: to, updatedAt: sql`now()` })
      .where(and(eq(requests.id, id), eq(requests.userId, userId), inArray(requests.status, sources)))
      .returning();
    if (updated) return { outcome: 'updated', request: updated };
  }

  const existing = await findRequestForUser(db, id, userId);
  return existing ? { outcome: 'invalid', current: existing.status } : { outcome: 'not_found' };
}
