import { createHmac, timingSafeEqual } from 'node:crypto';

import { Router, type Request, type Response } from 'express';

import { env } from '../config/env';
import { logger } from '../config/logger';
import { asyncHandler } from '../middleware/asyncHandler';
import { rateLimit } from '../middleware/rateLimit';
import { postcardFulfilment } from '../modules/postcards/fulfilment.service';
import { ok } from '../shared/respond';

/**
 * ═══ PRINT VENDOR CALLBACK (Phase 6.3) ═══
 *
 * ## What this is, and why it is small
 *
 * The vendor's OpenAPI document defines **no outbound status callbacks** — their only webhook route
 * is inbound, a way to place orders *at* them. Their portal does have a webhooks section, so
 * something can probably be configured, but the payload shape and signing scheme are undocumented
 * and unverified.
 *
 * So this endpoint is an ACCELERATOR, not the mechanism. Polling
 * (`postcardFulfilment.pollDue`) is what actually advances the pipeline, and it would keep working
 * perfectly if this route were deleted.
 *
 * ## Nothing in the body is believed
 *
 * We take exactly one thing from the payload — which order to look at — and then ask the vendor's
 * API what the status really is. The roadmap asked for this ("a signal to re-fetch, never
 * authoritative amounts") and it has a strong consequence: since no field is trusted, the worst a
 * forged request can achieve is making us re-poll an order we already own. That is harmless, and
 * rate-limited on top.
 *
 * Signature verification still runs whenever a secret is configured. The point is that correctness
 * does not depend on it — which is the only honest way to build against an unverified scheme.
 */

const log = logger.child({ webhook: 'print' });

export const printWebhookRouter = Router();

/**
 * Constant-time HMAC check, skipped entirely when no secret is set.
 *
 * Deliberately fail-OPEN on an unconfigured secret rather than fail-closed: with nothing to verify
 * against, rejecting every call would disable the accelerator without adding security, because the
 * request cannot cause anything a stranger could not already trigger by waiting for the poll. Once
 * `PCM_WEBHOOK_SECRET` exists, an invalid signature is refused.
 */
function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = env.PCM_WEBHOOK_SECRET;
  if (!secret) return true;
  if (!signature) return false;
  try {
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    const provided = Buffer.from(signature.trim(), 'hex');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

/**
 * Pulls the vendor's order id out of whatever they send.
 *
 * Tolerant of shape because the shape is unconfirmed — and safe to be tolerant, because the id is
 * only used as a lookup key for an order we must already own. An id we do not recognise is ignored.
 */
function extractVendorOrderId(body: unknown): string | null {
  const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const nested =
    root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : {};
  for (const candidate of [
    root.orderID,
    root.orderId,
    root.order_id,
    nested.orderID,
    nested.orderId,
    nested.order_id,
  ]) {
    if (typeof candidate === 'string' && candidate) return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

printWebhookRouter.post(
  '/print',
  rateLimit('write'),
  asyncHandler(async (req: Request, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));

    if (!verifySignature(raw, req.header('x-pcm-signature'))) {
      log.warn('rejected a print webhook with an invalid signature');
      // 200 on purpose: a rejected call is not the vendor's problem to retry, and returning an
      // error to an unauthenticated caller tells them whether they guessed the scheme.
      ok(res, { received: true });
      return;
    }

    let parsed: unknown = {};
    try {
      parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    } catch {
      log.warn('print webhook body was not JSON');
      ok(res, { received: true });
      return;
    }

    const vendorOrderId = extractVendorOrderId(parsed);
    if (!vendorOrderId) {
      log.warn('print webhook carried no recognisable order id');
      ok(res, { received: true });
      return;
    }

    /**
     * No event-id dedupe, and none is needed. The handler re-fetches authoritative status and the
     * stage machine ignores anything that is not forward progress, so a replayed call is already a
     * no-op — dedupe would be a second guard on a path that cannot double-apply.
     */
    const result = await postcardFulfilment.onVendorEvent(vendorOrderId).catch((err: unknown) => {
      // Never fail the vendor's request over our own downstream problem; the poll will catch up.
      log.error({ err, vendorOrderId }, 'print webhook could not be applied');
      return { handled: false };
    });

    ok(res, { received: true, handled: result.handled });
  }),
);
