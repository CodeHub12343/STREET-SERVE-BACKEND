import { ERROR_CODES, type ErrorCode } from './codes';

export interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  httpStatus: number;
  details?: unknown;
  retryable?: boolean;
  /** When false, the client receives a generic message (internals stay in logs). */
  expose?: boolean;
  cause?: unknown;
}

/**
 * The single error type the API throws for expected failures. The error middleware is the only
 * place an AppError becomes an HTTP response. Anything thrown that is not an AppError is treated
 * as an unexpected 500. See ERROR_HANDLING_STRATEGY.md.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly expose: boolean;

  constructor(opts: AppErrorOptions) {
    super(opts.message, { cause: opts.cause });
    this.name = 'AppError';
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.details = opts.details;
    this.retryable = opts.retryable ?? opts.httpStatus >= 500;
    this.expose = opts.expose ?? true;
    Error.captureStackTrace?.(this, AppError);
  }
}

// ─── Convenience constructors ────────────────────────────────────────────────────────────────
type Extra = { details?: unknown; retryable?: boolean; cause?: unknown };

export const ValidationError = (message = 'Validation failed', extra?: Extra): AppError =>
  new AppError({ code: ERROR_CODES.VALIDATION_ERROR, message, httpStatus: 400, ...extra });

export const UnauthenticatedError = (
  message = 'Authentication required',
  code: ErrorCode = ERROR_CODES.UNAUTHENTICATED,
  extra?: Extra,
): AppError => new AppError({ code, message, httpStatus: 401, ...extra });

export const ForbiddenError = (
  message = 'Not permitted',
  code: ErrorCode = ERROR_CODES.FORBIDDEN,
  extra?: Extra,
): AppError => new AppError({ code, message, httpStatus: 403, ...extra });

export const NotFoundError = (message = 'Not found', extra?: Extra): AppError =>
  new AppError({ code: ERROR_CODES.NOT_FOUND, message, httpStatus: 404, ...extra });

export const ConflictError = (
  code: ErrorCode = ERROR_CODES.CONFLICT,
  message = 'Conflict',
  extra?: Extra,
): AppError => new AppError({ code, message, httpStatus: 409, ...extra });

export const BusinessRuleError = (
  code: ErrorCode = ERROR_CODES.BUSINESS_RULE,
  message = 'Business rule violation',
  extra?: Extra,
): AppError => new AppError({ code, message, httpStatus: 422, ...extra });

export const RateLimitError = (message = 'Too many requests', extra?: Extra): AppError =>
  new AppError({
    code: ERROR_CODES.RATE_LIMITED,
    message,
    httpStatus: 429,
    retryable: true,
    ...extra,
  });

export const UpstreamError = (message = 'Upstream service error', extra?: Extra): AppError =>
  new AppError({
    code: ERROR_CODES.UPSTREAM_ERROR,
    message,
    httpStatus: 502,
    retryable: true,
    ...extra,
  });

export const UnavailableError = (message = 'Service unavailable', extra?: Extra): AppError =>
  new AppError({
    code: ERROR_CODES.SERVICE_UNAVAILABLE,
    message,
    httpStatus: 503,
    retryable: true,
    ...extra,
  });

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
