import { STATIC_QR_SUNSET_AT, STATIC_QR_WARN_DAYS } from '../../config/constants';

/**
 * 6.5 — the phase-out of the static hub QR.
 *
 * `allow_static_qr` was introduced as grandfathering for hubs that had already printed the
 * pre-rotation poster. The intent was always to chase them down and switch them off; nothing in the
 * code made that happen, so the flag was a permanent exception with a temporary name. Every hub
 * still on it can be defeated by anyone who photographed the poster once, which defeats the only
 * proof of physical presence in the custody model.
 *
 * The phase-out is therefore a **date**, in three layers, each of which can only shorten the window:
 *
 *   1. `allow_static_qr` — the hub was grandfathered at all.
 *   2. `static_qr_deadline_at` — the per-hub deadline, set when it was grandfathered.
 *   3. `STATIC_QR_SUNSET_AT` — the platform-wide end, which no hub can outlive even with a
 *      mis-set or missing deadline.
 *
 * A missing deadline is treated as **expired**, not as unlimited. That is the whole point: an
 * exception whose end date nobody recorded is exactly the exception that would otherwise live
 * forever, and defaulting it open would recreate the problem this file exists to close.
 */

export interface StaticQrHub {
  allow_static_qr?: boolean | null;
  static_qr_deadline_at?: Date | null;
}

/**
 * The effective end of static acceptance for a hub: the earlier of its own deadline and the
 * platform sunset. `null` when the hub was never grandfathered.
 */
export function staticQrExpiresAt(hub: StaticQrHub): Date | null {
  if (hub.allow_static_qr !== true) return null;
  const own = hub.static_qr_deadline_at;
  if (!own) return STATIC_QR_SUNSET_AT; // no recorded deadline → the platform sunset is the deadline
  return own < STATIC_QR_SUNSET_AT ? own : STATIC_QR_SUNSET_AT;
}

/** Whether this hub may still accept the raw static secret right now. */
export function staticQrAccepted(hub: StaticQrHub, now: Date = new Date()): boolean {
  const expiresAt = staticQrExpiresAt(hub);
  return expiresAt !== null && now < expiresAt;
}

/** Whole days until static acceptance ends; 0 once it has. `null` when it never applied. */
export function staticQrDaysRemaining(hub: StaticQrHub, now: Date = new Date()): number | null {
  const expiresAt = staticQrExpiresAt(hub);
  if (!expiresAt) return null;
  return Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000));
}

/**
 * What the hub's station screen should tell the owner. Deliberately blunt about consequence: a hub
 * that reads "static QR deprecated" and does nothing is a hub whose check-ins break without warning,
 * and the failure lands on a seller standing at the counter, not on the owner who ignored the notice.
 */
export function staticQrNotice(hub: StaticQrHub, now: Date = new Date()): string | null {
  const days = staticQrDaysRemaining(hub, now);
  if (days === null) return null;
  if (days === 0) {
    return 'Your old printed QR code no longer works. Sellers must scan the rotating code on this screen to check in.';
  }
  if (days <= STATIC_QR_WARN_DAYS) {
    return `Your old printed QR code stops working in ${days} day${days === 1 ? '' : 's'}. After that, sellers can only check in by scanning the rotating code on this screen — take the printed poster down now so nobody relies on it.`;
  }
  return `Your old printed QR code still works, until ${staticQrExpiresAt(hub)?.toISOString().slice(0, 10)}. It is less secure than the rotating code on this screen: anyone who photographed the poster can reserve stock without being here. Switch to the screen and take the poster down.`;
}
