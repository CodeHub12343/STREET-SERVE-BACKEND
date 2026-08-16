import express, { Router, type Request, type Response } from 'express';

import { env } from '../config/env';
import { logger } from '../config/logger';
import { asyncHandler } from '../middleware/asyncHandler';
import { stripe } from '../integrations/stripe';
import { verificationService } from '../modules/identity/verification.service';
import { paymentsService } from '../modules/payments/payments.service';
import { salePaymentsService } from '../modules/salepayments/salepayments.service';
import { pingService } from '../modules/growth/ping.service';
import { adsService } from '../modules/ads/ads.service';
import { payforwardService } from '../modules/payforward/payforward.service';
import { postcardsService } from '../modules/postcards/postcards.service';
import { sponsorsService } from '../modules/sponsors/sponsors.service';
import { rtoService } from '../modules/rto/rto.service';
import { subscriptionsService } from '../modules/subscriptions/subscriptions.service';
import { boostService } from '../modules/boost/boost.service';
import { ERROR_CODES } from '../shared/errors/codes';
import { ForbiddenError, ValidationError } from '../shared/errors/AppError';
import { ok } from '../shared/respond';

/**
 * Stripe webhook ingestion — signature-verified on the RAW body, deduped and processed
 * idempotently. Handles payments (PaymentIntent lifecycle, account updates) and Stripe Identity
 * KYC events. See THIRD_PARTY_INTEGRATIONS.md §4/§9.
 */
export const stripeWebhookRouter = Router();

stripeWebhookRouter.post(
  '/stripe',
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncHandler(async (req: Request, res: Response) => {
    const signature = req.header('stripe-signature');
    if (!env.STRIPE_WEBHOOK_SECRET) throw ValidationError('Stripe webhook secret not configured');
    if (!signature)
      throw ForbiddenError('Missing signature', ERROR_CODES.WEBHOOK_SIGNATURE_INVALID);

    let event;
    try {
      event = stripe().constructWebhookEvent(
        req.body as Buffer,
        signature,
        env.STRIPE_WEBHOOK_SECRET,
      );
    } catch {
      throw ForbiddenError('Invalid webhook signature', ERROR_CODES.WEBHOOK_SIGNATURE_INVALID);
    }

    const obj = event.data.object;
    switch (event.type) {
      case 'payment_intent.succeeded': {
        // A consignment sale payment is a separate-charges intent owned by the sale-payments
        // module; anything else is an ordinary order charge. Try the consignment path first and
        // fall through when the intent isn't one of ours.
        const handled = await salePaymentsService.onPaymentSucceeded(String(obj.id));
        if (handled.handled) break;
        // A vendor's ping-budget prepayment — credits the budget only now that the money exists.
        const topup = await pingService.creditTopup(String(obj.id));
        if (topup.handled) break;
        // A paid placement — starts delivering only now that it has been paid for.
        const placement = await adsService.activateByPaymentIntent(String(obj.id));
        if (placement.handled) break;
        // A Pay It Forward contribution — the pool is credited HERE and nowhere else, so a balance
        // can never rise against money that has not arrived (ADR-005; the PingBudgetTopup lesson).
        const contribution = await payforwardService.creditContribution(String(obj.id));
        if (contribution.handled) break;
        // A Boost campaign contribution — captured on contribution (ADR-006), credited to the
        // campaign's own escrow account only once the money has actually arrived.
        const boost = await boostService.creditContribution(String(obj.id));
        if (boost.handled) break;
        // A postcard order (ADR-007). Books the capture and accrues the vendor debt HERE and
        // nowhere else, so the books can never show a sale whose money has not arrived.
        const postcard = await postcardsService.completeByPaymentIntent(String(obj.id));
        if (postcard.handled) break;
        // A self-serve sponsorship. Moves it to REVIEW, never straight to live: publishing on
        // payment alone would let anyone with a card put an arbitrary image on the landing page.
        const sponsorship = await sponsorsService.activateByPaymentIntent(String(obj.id));
        if (sponsorship.handled) break;
        // A Rent-to-Own acceptance or early payoff. Ownership credit, the immutable ledger entry,
        // the consignment split and the ownership TRANSFER all happen here and nowhere else — the
        // accept/payoff endpoints only open the charge, so nobody gains equity in an item against a
        // card that was never confirmed.
        const rto = await rtoService.creditByPaymentIntent(String(obj.id));
        if (rto.handled) break;
        await paymentsService.completeByPaymentIntent(String(obj.id));
        break;
      }
      /**
       * A card was stored without a payment being taken — a Rent-to-Own agreement that owed nothing
       * on day one but whose twelve scheduled instalments still need something to charge. No money
       * moves here; this only attaches the credential.
       */
      case 'setup_intent.succeeded': {
        await rtoService.attachCardBySetupIntent(String(obj.id));
        break;
      }
      case 'payment_intent.payment_failed': {
        const reason =
          (obj.last_payment_error as { message?: string } | undefined)?.message ?? 'payment_failed';
        const handled = await salePaymentsService.onPaymentFailed(String(obj.id), reason);
        if (handled.handled) break;
        // A contribution left at `pending` forever is indistinguishable from one still in flight.
        const failedContribution = await payforwardService.failContribution(String(obj.id), reason);
        if (failedContribution.handled) break;
        const failedBoost = await boostService.failContribution(String(obj.id), reason);
        if (failedBoost.handled) break;
        const failedPostcard = await postcardsService.failByPaymentIntent(String(obj.id), reason);
        if (failedPostcard.handled) break;
        // A placement left pending for ever is indistinguishable from one still being paid for.
        const failedSponsor = await sponsorsService.failByPaymentIntent(String(obj.id), reason);
        if (failedSponsor.handled) break;
        await paymentsService.failByPaymentIntent(String(obj.id));
        break;
      }
      /**
       * A customer disputed the card charge. Freeze the seller's payouts immediately: money that
       * leaves now is effectively unrecoverable, and the platform is liable for the chargeback as
       * merchant of record.
       */
      case 'charge.dispute.created': {
        await salePaymentsService.onChargeDisputed(
          String(obj.payment_intent ?? ''),
          String(obj.reason ?? 'chargeback'),
        );
        break;
      }
      case 'charge.dispute.closed': {
        await salePaymentsService.onChargeDisputeClosed(
          String(obj.payment_intent ?? ''),
          String(obj.status ?? 'lost'),
        );
        break;
      }
      /**
       * The whole recurring half of a subscription's life.
       *
       * `subscribe` records a status once and `confirm` settles it after the first payment — and
       * before these cases existed, nothing ever touched the record again. Entitlement reads
       * `status` alone, so a card that failed next month left Pro, Featured, Verified, the AI
       * assistant, Seller Plus and the Stock Protection waiver running indefinitely, unpaid.
       *
       * `updated` carries every transition that matters (`active → past_due`, recovery back to
       * `active`, a scheduled cancel) and `deleted` is the final stop, so the two together are
       * sufficient. `invoice.payment_failed` is deliberately NOT handled: Stripe follows it with a
       * subscription.updated carrying the new status, and acting on both would mean two sources of
       * truth for one fact.
       */
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await subscriptionsService.applyStripeState(String(obj.id), {
          status: String(obj.status ?? 'canceled'),
          currentPeriodEnd:
            typeof obj.current_period_end === 'number' ? obj.current_period_end : null,
          cancelAtPeriodEnd: Boolean(obj.cancel_at_period_end),
        });
        break;
      }
      case 'account.updated': {
        const account = await paymentsService.refreshAccountStatus(String(obj.id));
        if (account?.payouts_enabled) {
          await verificationService.onPayoutsEnabled(account.owner_type, account.owner_id);
        }
        break;
      }
      case 'identity.verification_session.verified':
        await verificationService.applyKycResult(String(obj.id), 'approved');
        break;
      case 'identity.verification_session.requires_input':
      case 'identity.verification_session.canceled':
        await verificationService.applyKycResult(String(obj.id), 'rejected');
        break;
      default:
        logger.debug({ type: event.type }, 'unhandled stripe event');
    }

    ok(res, { received: true, type: event.type });
  }),
);
