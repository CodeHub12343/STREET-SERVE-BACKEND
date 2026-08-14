import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '../../config/env';

/**
 * Verify an inbound user-sync webhook (Clerk uses Svix-style HMAC; Auth0 log-streams sign
 * similarly). We verify an HMAC-SHA256 of the raw body against the shared secret, comparing in
 * constant time. Webhook routes are exempt from bearer auth but never from signature
 * verification (THIRD_PARTY_INTEGRATIONS.md §9).
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!env.AUTH_WEBHOOK_SECRET || !signatureHeader) return false;
  const expected = createHmac('sha256', env.AUTH_WEBHOOK_SECRET).update(rawBody).digest('hex');
  // Header may carry multiple space-separated signatures (rotation). Accept any match.
  const candidates = signatureHeader.split(/[,\s]+/).filter(Boolean);
  return candidates.some((sig) => {
    const provided = sig.includes('=') ? sig.split('=').pop()! : sig;
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export interface UserSyncEvent {
  type: 'user.created' | 'user.updated' | 'user.deleted';
  authProviderId: string;
  email?: string;
  phone?: string;
  displayName?: string;
}

/** Normalise a provider payload into our neutral shape (Clerk-shaped example). */
export function parseUserSyncEvent(body: unknown): UserSyncEvent | null {
  if (typeof body !== 'object' || body === null) return null;
  const evt = body as Record<string, unknown>;
  const type = evt.type as UserSyncEvent['type'] | undefined;
  if (type !== 'user.created' && type !== 'user.updated' && type !== 'user.deleted') return null;

  const data = (evt.data ?? {}) as Record<string, unknown>;
  const id = (data.id ?? data.user_id) as string | undefined;
  if (!id) return null;

  const emails = data.email_addresses as Array<{ email_address?: string }> | undefined;
  const phones = data.phone_numbers as Array<{ phone_number?: string }> | undefined;
  return {
    type,
    authProviderId: id,
    email: (data.email as string) ?? emails?.[0]?.email_address,
    phone: (data.phone as string) ?? phones?.[0]?.phone_number,
    displayName:
      ((data.display_name as string) ??
        [data.first_name, data.last_name].filter(Boolean).join(' ')) ||
      undefined,
  };
}
