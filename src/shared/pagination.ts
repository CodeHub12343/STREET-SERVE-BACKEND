import { z } from 'zod';

import { ValidationError } from './errors';

/**
 * Cursor-based pagination only. Offset pagination drifts on continuously-inserted collections
 * (live pins, transactions) — API_SPECIFICATION.md §18, VALIDATION_RULES.md §1.
 * The cursor is an opaque base64 of the last item's sort key(s).
 */
export const PaginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;

export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor<T = Record<string, unknown>>(cursor?: string): T | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    throw ValidationError('Invalid pagination cursor');
  }
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
