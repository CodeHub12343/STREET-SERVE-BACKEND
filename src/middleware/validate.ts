import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';

import { ValidationError } from '../shared/errors/AppError';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Zod validation at the HTTP edge. Parsed, typed results are attached to `req.valid` (we do not
 * reassign req.query, which is read-only in newer Express). Unknown fields should be rejected by
 * using `.strict()` object schemas. See VALIDATION_RULES.md §1.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.valid = {
        body: schemas.body ? schemas.body.parse(req.body) : undefined,
        query: schemas.query ? schemas.query.parse(req.query) : undefined,
        params: schemas.params ? schemas.params.parse(req.params) : undefined,
      };
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const fieldErrors = err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        }));
        throw ValidationError('Request validation failed', { details: { fieldErrors } });
      }
      throw err;
    }
  };
}

/** Convenience typed accessors for controllers. */
export function body<T>(req: Request): T {
  return req.valid?.body as T;
}
export function query<T>(req: Request): T {
  return req.valid?.query as T;
}
export function params<T>(req: Request): T {
  return req.valid?.params as T;
}
