import { z } from 'zod';
import { REQUEST_STATUSES } from '../../db/schema.js';

// Strict objects reject unknown keys, so a client cannot smuggle in `userId` or `status`.
export const createRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  // Blank descriptions are stored as null rather than as an empty string.
  description: z
    .string()
    .trim()
    .max(2000)
    .nullish()
    .transform((value) => value || null),
});

export const updateStatusSchema = z.strictObject({
  status: z.enum(REQUEST_STATUSES),
});

export const requestIdParamsSchema = z.object({
  id: z.uuid(),
});

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreateRequestInput = z.output<typeof createRequestSchema>;
