import { sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const REQUEST_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;

export const requestStatus = pgEnum('request_status', REQUEST_STATUSES);

export const requests = pgTable(
  'requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The user lives in the Identity Service's database, so there is no foreign key.
    userId: uuid('user_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: requestStatus('status').notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Serves "my requests, newest first" without a sort step.
    index('requests_user_id_created_at_idx').on(table.userId, table.createdAt.desc(), table.id.desc()),
    // Mirrors the API validation, so rows written by other means still respect the limits.
    check('requests_title_length', sql`char_length(btrim(${table.title})) between 1 and 200`),
    check(
      'requests_description_length',
      sql`${table.description} is null or char_length(${table.description}) <= 2000`,
    ),
  ],
);

export type Request = typeof requests.$inferSelect;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
