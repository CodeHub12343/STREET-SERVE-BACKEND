import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Rotating hub check-in tokens (Phase 6 hardening).
 *
 * THE PROBLEM THIS FIXES: the hub's QR was a single static secret checked by string equality.
 * Anyone who photographed the printed code once could reserve stock from anywhere, forever —
 * defeating the only proof of physical presence in the whole custody model.
 *
 * The fix is TOTP-shaped: the hub's stored secret becomes a signing key that is never displayed.
 * What the station shows is an HMAC over a time window, so a photographed code stops working
 * within a minute. Verification accepts the neighbouring windows to tolerate clock skew and the
 * seconds between scanning and submitting.
 */

/**
 * Token lifetime.
 *
 * **Set to 1 hour at the product owner's request (was 30s).** Recorded plainly because it is a
 * deliberate trade against the control this file exists to provide: with `SKEW_WINDOWS = 1` a
 * photographed code now works for up to two hours rather than a minute, so proof of physical
 * presence becomes proof of having been near the hub at some point today. Anyone who photographs
 * the station screen can reserve stock remotely for the rest of the window.
 *
 * That is a defensible call for a trusted-hub pilot where sellers were failing to scan in time, and
 * a bad one at scale. It is one number, so shortening it later is a config change rather than a
 * redesign.
 */
export const QR_WINDOW_SECONDS = 3600;
/**
 * Windows either side accepted — covers clock skew and slow submissions.
 *
 * At a 1-hour window this is the difference between a worst case of 1 hour and 2 hours of validity,
 * so it matters more than it did at 30 seconds. Kept at 1 because a hub tablet with a drifting
 * clock would otherwise reject every scan, which is a worse failure than a longer window.
 */
const SKEW_WINDOWS = 1;

const TOKEN_PREFIX = 'ssq1'; // versioned, so the format can change without ambiguity

function windowId(at: number = Date.now()): number {
  return Math.floor(at / 1000 / QR_WINDOW_SECONDS);
}

function sign(secret: string, hubId: string, win: number): string {
  return createHmac('sha256', secret)
    .update(`${hubId}:${win}`)
    .digest('base64url')
    .slice(0, 24);
}

/** The token a hub's station should display right now. */
export function currentQrToken(
  secret: string,
  hubId: string,
  at: number = Date.now(),
): { token: string; expiresAt: Date; rotateSeconds: number } {
  const win = windowId(at);
  return {
    token: `${TOKEN_PREFIX}.${win}.${sign(secret, hubId, win)}`,
    expiresAt: new Date((win + 1) * QR_WINDOW_SECONDS * 1000),
    rotateSeconds: QR_WINDOW_SECONDS,
  };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Compare lengths first — timingSafeEqual throws on a mismatch.
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Verify a scanned token. Returns false for anything malformed, expired, or signed with the wrong
 * key — the caller must not distinguish these to a client.
 */
export function verifyQrToken(
  secret: string,
  hubId: string,
  token: string,
  at: number = Date.now(),
): boolean {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return false;

  const win = Number(parts[1]);
  if (!Number.isFinite(win)) return false;

  const now = windowId(at);
  // Reject windows outside the accepted band before doing any crypto.
  if (Math.abs(now - win) > SKEW_WINDOWS) return false;

  return safeEqual(parts[2]!, sign(secret, hubId, win));
}

/** Whether a submitted value looks like a rotating token at all (vs a legacy static secret). */
export function isRotatingToken(token: string): boolean {
  return typeof token === 'string' && token.startsWith(`${TOKEN_PREFIX}.`);
}
