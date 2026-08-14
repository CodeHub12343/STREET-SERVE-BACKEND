import { TIER_RANK, VERIFICATION_TYPE_TIER, type Tier } from '../../config/constants';
import { env, isProd } from '../../config/env';
import { publish } from '../../events/bus';
import { kyc } from '../../integrations/kyc';
import { writeAudit } from '../../shared/audit';
import type { Principal } from '../../shared/types/principal';
import { paymentsService } from '../payments/payments.service';
import { identityRepository as repo } from './identity.repository';

/**
 * Identity verification (KYC) lifecycle. We store only a provider reference + status, never raw
 * documents. Tiers: id_document/selfie → Bronze; bank_account (Stripe Connect payouts) → Silver;
 * Gold is trust-gated (later phase). Portable across roles (Q10).
 * See AUTHENTICATION_AND_AUTHORIZATION.md §5 and API_SPECIFICATION.md §17.
 */
export const verificationService = {
  /** Start the hosted ID + selfie-liveness flow (Stripe Identity 'document' covers both). */
  async startIdVerification(principal: Principal) {
    const existing = await repo.findPendingVerification(principal.userId, 'id_document');

    // Dev-only fast path. No Stripe Identity webhook is wired locally (STRIPE_WEBHOOK_SECRET is a
    // placeholder), so a real submission sits `pending` forever and the seller can never reach
    // Bronze — which blocks checkout. When explicitly enabled in a non-production env, approve
    // immediately (reusing applyKycResult so payout-hold sync + tier_changed still fire) so the
    // whole verify → Bronze → checkout journey is walkable. The `!isProd` guard makes this
    // impossible in production regardless of the flag.
    if (!isProd && env.KYC_DEV_AUTO_APPROVE) {
      const providerReference =
        existing?.provider_reference ?? `dev-auto-${principal.userId}-${Date.now()}`;
      if (!existing) {
        await repo.createVerification({
          user_id: principal.userId,
          tier: 'bronze',
          verification_type: 'id_document',
          provider: 'dev-auto',
          provider_reference: providerReference,
        });
      }
      await this.applyKycResult(providerReference, 'approved');
      return { providerReference, url: null, clientSecret: null, reused: Boolean(existing) };
    }

    if (existing?.provider_reference) {
      return {
        providerReference: existing.provider_reference,
        url: null,
        clientSecret: null,
        reused: true,
      };
    }
    const session = await kyc().createSession({
      userId: principal.userId,
      returnUrl: env.KYC_RETURN_URL,
    });
    await repo.createVerification({
      user_id: principal.userId,
      tier: 'bronze',
      verification_type: 'id_document',
      provider: env.KYC_PROVIDER,
      provider_reference: session.providerReference,
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'verification.started',
      entityType: 'verification',
      entityId: session.providerReference,
      metadata: { type: 'id_document' },
    });
    return {
      providerReference: session.providerReference,
      url: session.url,
      clientSecret: session.clientSecret,
      reused: false,
    };
  },

  /** Apply a KYC provider result (from webhook) to the matching pending record. */
  async applyKycResult(providerReference: string, status: 'approved' | 'rejected') {
    const record = await repo.findVerificationByProviderRef(providerReference);
    if (!record) return; // unknown reference — ignore idempotently
    if (record.status !== 'pending') return;

    await repo.setVerificationStatus(String(record._id), status);
    await writeAudit({
      actorId: String(record.user_id),
      action: `verification.${status}`,
      entityType: 'verification',
      entityId: providerReference,
      metadata: { type: record.verification_type },
    });
    if (status === 'approved') {
      // A tier change must actually move the payout hold, not just the badge (Phase 3).
      await paymentsService.syncPayoutHold('user', String(record.user_id), record.tier);
      await publish('verification.tier_changed', {
        userId: String(record.user_id),
        tier: record.tier,
      });
    }
  },

  /** Link a payout bank account via Stripe Connect onboarding → unlocks Silver on completion. */
  async linkBankAccount(principal: Principal) {
    const { url, stripeAccountId } = await paymentsService.createOnboardingLink(
      'user',
      principal.userId,
      principal.email,
    );
    const existing = await repo.findPendingVerification(principal.userId, 'bank_account');
    if (!existing) {
      await repo.createVerification({
        user_id: principal.userId,
        tier: 'silver',
        verification_type: 'bank_account',
        provider: 'stripe_connect',
        provider_reference: stripeAccountId,
      });
    }
    return { url };
  },

  /** Called when a connected account's payouts become enabled → approve Silver + set schedule. */
  async onPayoutsEnabled(ownerType: string, ownerId: string) {
    if (ownerType !== 'user') return;
    const record = await repo.findPendingVerification(ownerId, 'bank_account');
    if (!record) return;
    await repo.setVerificationStatus(String(record._id), 'approved');
    if (record.provider_reference) {
      await paymentsService.setPayoutTier(record.provider_reference, 'silver');
    }
    await publish('verification.tier_changed', { userId: ownerId, tier: 'silver' });
    await writeAudit({
      actorId: ownerId,
      action: 'verification.approved',
      entityType: 'verification',
      entityId: String(record._id),
      metadata: { type: 'bank_account' },
    });
  },

  async getStatus(principal: Principal) {
    const records = await repo.allVerifications(principal.userId);
    const approvedTiers = records.filter((r) => r.status === 'approved').map((r) => r.tier);
    const currentTier = approvedTiers.reduce<Tier>(
      (best, t) => (TIER_RANK[t] > TIER_RANK[best] ? t : best),
      'tier0',
    );
    const pending = records
      .filter((r) => r.status === 'pending')
      .map((r) => ({
        type: r.verification_type,
        unlocks: VERIFICATION_TYPE_TIER[r.verification_type],
      }));
    return {
      currentTier,
      records: records.map((r) => ({
        type: r.verification_type,
        status: r.status,
        tier: r.tier,
        verifiedAt: r.verified_at,
      })),
      pending,
    };
  },
};
