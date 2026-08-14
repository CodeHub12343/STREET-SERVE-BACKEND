import type { Principal } from '../shared/types/principal';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requestContext middleware. */
      requestId?: string;
      correlationId?: string;
      /** Set by the auth middleware after JWT verification + Principal load. */
      principal?: Principal;
      /** Set by the validate middleware — parsed, typed request parts. */
      valid?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
      /** Raw body buffer, captured on webhook routes for signature verification. */
      rawBody?: Buffer;
    }
  }
}

export {};
