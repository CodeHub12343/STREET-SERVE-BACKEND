import type { NextFunction, Request, Response } from 'express';

import { logger } from '../config/logger';
import { isProd } from '../config/env';
import { ERROR_CODES } from '../shared/errors/codes';
import { AppError, isAppError } from '../shared/errors/AppError';

/** MongoServerError code for a duplicate-key (unique index) violation. */
const MONGO_DUPLICATE_KEY_CODE = 11000;

/** 404 for unmatched routes — funnels into the same envelope as everything else. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(
    new AppError({
      code: ERROR_CODES.NOT_FOUND,
      message: `Route not found: ${req.method} ${req.path}`,
      httpStatus: 404,
    }),
  );
}

function normalize(err: unknown): AppError {
  if (isAppError(err)) return err;

  // Mongo duplicate key.
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: number }).code === MONGO_DUPLICATE_KEY_CODE
  ) {
    return new AppError({
      code: ERROR_CODES.DUPLICATE,
      message: 'Resource already exists',
      httpStatus: 409,
      details: (err as { keyValue?: unknown }).keyValue,
    });
  }

  // Mongoose validation / cast errors.
  const name = (err as { name?: string }).name;
  if (name === 'ValidationError') {
    return new AppError({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Data validation failed',
      httpStatus: 400,
    });
  }
  if (name === 'CastError') {
    return new AppError({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Malformed identifier',
      httpStatus: 400,
    });
  }

  // Unknown → 500, internals hidden from the client.
  return new AppError({
    code: ERROR_CODES.INTERNAL_ERROR,
    message: 'An unexpected error occurred',
    httpStatus: 500,
    expose: false,
    cause: err,
  });
}

/**
 * The single place an error becomes an HTTP response. Picks status/code, logs at the right level,
 * strips internals when not exposable, and always attaches requestId. See ERROR_HANDLING_STRATEGY.md.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const appErr = normalize(err);
  const requestId = req.requestId;

  const logPayload = {
    err: appErr.expose ? undefined : (appErr.cause ?? appErr),
    code: appErr.code,
    httpStatus: appErr.httpStatus,
    requestId,
    path: req.path,
    method: req.method,
    userId: req.principal?.userId,
  };
  if (appErr.httpStatus >= 500) logger.error(logPayload, appErr.message);
  else logger.warn(logPayload, appErr.message);

  if (res.headersSent) return;

  res.status(appErr.httpStatus).json({
    error: {
      code: appErr.code,
      message: appErr.expose ? appErr.message : 'An unexpected error occurred',
      details: appErr.expose ? appErr.details : undefined,
      requestId,
      retryable: appErr.retryable,
      ...(isProd ? {} : { stack: appErr.expose ? undefined : (appErr.cause as Error)?.stack }),
    },
  });
}
