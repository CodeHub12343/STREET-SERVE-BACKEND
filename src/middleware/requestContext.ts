import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { runWithContext } from '../shared/context';

/**
 * Establishes per-request correlation. Generates a requestId, adopts an inbound correlationId if
 * present, and runs the remainder of the request inside AsyncLocalStorage so logs, events, jobs,
 * and socket emits can all reference the same trace. See LOGGING_AND_MONITORING.md §1.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  const correlationId = req.header('x-correlation-id') ?? requestId;
  req.requestId = requestId;
  req.correlationId = correlationId;
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-correlation-id', correlationId);
  runWithContext({ requestId, correlationId }, () => next());
}
