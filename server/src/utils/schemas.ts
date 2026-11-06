/**
 * Shared validation schemas used across route handlers.
 * These are kept in a zero-import leaf module to avoid circular dependencies.
 */

import { z } from 'zod';

/**
 * Standard pagination schema using `page` and `limit` field names.
 * min=1, max=100 per field, defaults: page=1, limit=20.
 */
export const paginationWithLimitSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Standard pagination schema for data-api endpoints using `limit` and `offset`.
 * Offset validation happens after schema parse in the route handler.
 * min=1 for limit (except offset can be 0), max=500.
 */
export const dataApiPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  cursor: z.coerce.number().int().min(0).optional(),
});
