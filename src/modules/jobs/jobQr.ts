import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Rotating job check-in tokens (S-14 QR fallback, COMPONENT_LIBRARY.md).
 *
 * WHY THIS EXISTS: check-in was geofence-only. GPS indoors, in a basement loading bay, or under a
 * market awning is exactly where it fails — so a worker who genuinely turned up could be unable to
 * start their shift, with no alternative. The QR is that alternative: the employer shows a code at
 * the site, and scanning it proves presence the same way standing in the geofence does.
 *
 * Same TOTP shape as the hub station (`consignment/hubQr.ts`), and for the same reason: a STATIC
 * code could be photographed once and reused from anywhere, which would defeat the only proof of
 * presence the gig has. The stored secret is a signing key that is never displayed; what's shown is
 * an HMAC over a 30-second window.
 */

/** Token lifetime. Short enough that a leaked photo is near-worthless, long enough to scan. */
export const JOB_QR_WINDOW_SECONDS = 30;
/** Windows either side accepted — covers clock skew and the seconds between scan and submit. */
const SKEW_WINDOWS = 1;

const TOKEN_PREFIX = 'ssj1'; // versioned + distinct from the hub's `ssq1`, so the two never collide

function windowId(at: number = Date.now()): number {
  return Math.floor(at / 1000 / JOB_QR_WINDOW_SECONDS);
}

function sign(secret: string, jobId: string, win: number): string {
  return createHmac('sha256', secret).update(`${jobId}:${win}`).digest('base64url').slice(0, 24);
}

/** The token this job's on-site display should show right now. */
export function currentJobQrToken(
  secret: string,
  jobId: string,
  at: number = Date.now(),
): { token: string; expiresAt: Date; rotateSeconds: number } {
  const win = windowId(at);
  return {
    token: `${TOKEN_PREFIX}.${win}.${sign(secret, jobId, win)}`,
    expiresAt: new Date((win + 1) * JOB_QR_WINDOW_SECONDS * 1000),
    rotateSeconds: JOB_QR_WINDOW_SECONDS,
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
export function verifyJobQrToken(
  secret: string,
  jobId: string,
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

  return safeEqual(parts[2]!, sign(secret, jobId, win));
}
