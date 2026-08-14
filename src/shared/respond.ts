import type { Response } from 'express';

/** Success envelope: { data, meta? }. Errors use the envelope in middleware/errorHandler.ts. */
export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>, status = 200): void {
  res.status(status).json(meta ? { data, meta } : { data });
}

export function created<T>(res: Response, data: T, meta?: Record<string, unknown>): void {
  ok(res, data, meta, 201);
}
