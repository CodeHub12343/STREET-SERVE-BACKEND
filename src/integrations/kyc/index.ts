import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '../../config/env';
import { stripe } from '../stripe';

/**
 * KYC (identity verification) gateway — ID + selfie liveness. Provider-agnostic so Stripe Identity
 * and Persona are swappable. We store only a provider reference + status, never the raw documents
 * (SECURITY_GUIDELINES.md §2, Q7). Injectable for tests.
 */
export interface KycSession {
  providerReference: string;
  url: string | null;
  clientSecret: string | null;
}

export interface KycResult {
  providerReference: string;
  status: 'approved' | 'rejected';
  userId?: string;
}

export interface KycGateway {
  createSession(input: { userId: string; returnUrl: string }): Promise<KycSession>;
  /** Verify + normalize a provider webhook; returns null for events we ignore. */
  parseWebhook(rawBody: Buffer, signature: string | undefined): KycResult | null;
}

// ─── Default: Stripe Identity (rides the Stripe gateway) ───────────────────────────────────
class StripeIdentityGateway implements KycGateway {
  async createSession(input: { userId: string; returnUrl: string }): Promise<KycSession> {
    const session = await stripe().createIdentitySession(input);
    return {
      providerReference: session.sessionId,
      url: session.url,
      clientSecret: session.clientSecret,
    };
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): KycResult | null {
    if (!env.STRIPE_WEBHOOK_SECRET || !signature) return null;
    const event = stripe().constructWebhookEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    if (event.type === 'identity.verification_session.verified') {
      const obj = event.data.object;
      return {
        providerReference: String(obj.id),
        status: 'approved',
        userId: (obj.metadata as Record<string, string> | undefined)?.userId,
      };
    }
    if (
      event.type === 'identity.verification_session.requires_input' ||
      event.type === 'identity.verification_session.canceled'
    ) {
      const obj = event.data.object;
      return { providerReference: String(obj.id), status: 'rejected' };
    }
    return null;
  }
}

// ─── Persona (HMAC-signed webhook) ─────────────────────────────────────────────────────────
class PersonaGateway implements KycGateway {
  createSession(): Promise<KycSession> {
    // Persona hosted-flow creation is done via their Inquiry API; wired when selected.
    return Promise.reject(new Error('Persona session creation not configured'));
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): KycResult | null {
    if (!env.KYC_WEBHOOK_SECRET || !signature) return null;
    const expected = createHmac('sha256', env.KYC_WEBHOOK_SECRET).update(rawBody).digest('hex');
    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(rawBody.toString('utf8')) as {
      data?: { attributes?: { status?: string; 'reference-id'?: string }; id?: string };
    };
    const status = payload.data?.attributes?.status;
    const ref = payload.data?.id;
    if (!ref || !status) return null;
    return {
      providerReference: ref,
      status: status === 'completed' || status === 'approved' ? 'approved' : 'rejected',
      userId: payload.data?.attributes?.['reference-id'],
    };
  }
}

let gateway: KycGateway | null = null;

export function setKycGateway(next: KycGateway): void {
  gateway = next;
}

export function kyc(): KycGateway {
  gateway ??= env.KYC_PROVIDER === 'persona' ? new PersonaGateway() : new StripeIdentityGateway();
  return gateway;
}
