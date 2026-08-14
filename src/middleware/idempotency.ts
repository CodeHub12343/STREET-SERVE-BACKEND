import { createHash } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { IDEMPOTENCY_TTL_SEC } from '../config/constants';
import { kv } from '../shared/kv';
import { ERROR_CODES } from '../shared/errors/codes';
import { ConflictError, UnauthenticatedError, ValidationError } from '../shared/errors/AppError';
import { asyncHandler } from './asyncHandler';

interface StoredResult {
  bodyHash: string;
  status?: number;
  response?: unknown;
}

/**
 * Order-independent view of a request body.
 *
 * `JSON.stringify` preserves insertion order, so `{amount, note}` and `{note, amount}` — the same
 * request, serialised by two clients — hashed differently and the retry was rejected as a body
 * mismatch. That turned an ordinary retry into a 409 the caller could not clear, on exactly the
 * endpoints where retrying is the correct behaviour.
 *
 * Keys are sorted at every depth before hashing. `undefined` members are dropped by `JSON.stringify`
 * either way, so an absent key and an explicitly-undefined one continue to agree.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalise(source[key]);
    return out;
  }
  return value;
}

function hashBody(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalise(body ?? {})))
    .digest('hex');
}

/**
 * Idempotency for money-mutating POSTs. A repeated Idempotency-Key with the same body returns the
 * cached first response (never a second charge); a reused key with a different body is a 409.
 * See ERROR_HANDLING_STRATEGY.md §5 and API_SPECIFICATION.md §18.
 *
 * ## Reserve first, then read
 *
 * The reservation is what makes this safe, so it happens before anything else. The previous order —
 * `get`, decide, then `setNx` whose result was discarded — was a check-then-act race: two concurrent
 * retries of the same request both read an empty key, both concluded they were first, and both ran
 * the handler. Under a double-tap or a client auto-retry that is a double charge, which is precisely
 * what this middleware exists to prevent. `setNx` is atomic; its answer is now the decision.
 *
 * ## What gets cached
 *
 * Only a **2xx** response is stored for replay. The three cases differ in what is actually known:
 *
 * - **2xx** — the operation succeeded. Cache it; every retry replays it instead of re-charging.
 * - **4xx** — the request was rejected before doing anything. Release the key so a corrected retry
 *   is not permanently locked out by a reservation guarding an operation that never happened.
 * - **5xx, or no response at all** — the outcome is **unknown**. The reservation deliberately
 *   stands: retries get a retryable conflict until the TTL expires. Releasing here would allow a
 *   second attempt at an operation that may already have moved money, and for a money path an
 *   unnecessary delay is a far better failure than a duplicate charge.
 *
 * Previously every response was cached, so a transient 500 was pinned for the full 24h TTL and
 * replayed to the client as a successful idempotent hit.
 */
export const idempotency: RequestHandler = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header('idempotency-key');
    if (!key) throw ValidationError('Idempotency-Key header is required for this operation');
    if (!req.principal) throw UnauthenticatedError('Authentication required');

    const storeKey = `idem:${req.principal.userId}:${key}`;
    const bodyHash = hashBody(req.body);

    const reserved = await kv().setNx(
      storeKey,
      JSON.stringify({ bodyHash } satisfies StoredResult),
      IDEMPOTENCY_TTL_SEC,
    );

    if (!reserved) {
      const existingRaw = await kv().get(storeKey);
      // Expired between the setNx and the read. Vanishingly rare, and the safe reading is "someone
      // else holds this" rather than "nobody does" — ask for a retry instead of racing them.
      if (!existingRaw) {
        throw ConflictError(ERROR_CODES.IDEMPOTENCY_CONFLICT, 'Original request still processing', {
          retryable: true,
        });
      }
      const existing = JSON.parse(existingRaw) as StoredResult;
      if (existing.bodyHash !== bodyHash) {
        throw ConflictError(
          ERROR_CODES.IDEMPOTENCY_CONFLICT,
          'Idempotency-Key already used with a different request body',
        );
      }
      if (existing.response !== undefined) {
        res.setHeader('Idempotent-Replay', 'true');
        res.status(existing.status ?? 200).json(existing.response);
        return;
      }
      // Original request still in flight — ask the client to retry shortly.
      throw ConflictError(ERROR_CODES.IDEMPOTENCY_CONFLICT, 'Original request still processing', {
        retryable: true,
      });
    }

    const originalJson = res.json.bind(res);
    res.json = (payload: unknown): Response => {
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        void kv().set(
          storeKey,
          JSON.stringify({ bodyHash, status, response: payload } satisfies StoredResult),
          IDEMPOTENCY_TTL_SEC,
        );
      } else if (status >= 400 && status < 500) {
        void kv().del(storeKey);
      }
      return originalJson(payload);
    };

    next();
  },
);
