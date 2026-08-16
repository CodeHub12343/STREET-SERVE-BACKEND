import Stripe from 'stripe';

import { env } from '../../config/env';
import type {
  AccountBalance,
  BalanceTxn,
  CreateConnectedAccountInput,
  DestinationChargeInput,
  StripeAccountStatus,
  StripeGateway,
  StripeWebhookEvent,
} from './types';

/**
 * Real Stripe Connect gateway. Constructed lazily so the app boots (and Phase 0 dev/tests run)
 * without live keys; any actual money call requires STRIPE_SECRET_KEY. Uses destination charges
 * with an application fee — one call charges the customer and routes the net to the connected
 * account (the "split payout"). See THIRD_PARTY_INTEGRATIONS.md §4.
 */
export class StripeConnectGateway implements StripeGateway {
  private client: Stripe;

  constructor(secretKey: string) {
    this.client = new Stripe(secretKey);
  }

  async createConnectedAccount(input: CreateConnectedAccountInput): Promise<{ accountId: string }> {
    const account = await this.client.accounts.create({
      type: 'express',
      country: input.country,
      email: input.email,
      capabilities: {
        transfers: { requested: true },
        card_payments: { requested: true },
      },
      metadata: input.metadata,
    });
    return { accountId: account.id };
  }

  async createOnboardingLink(input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const link = await this.client.accountLinks.create({
      account: input.accountId,
      refresh_url: input.refreshUrl,
      return_url: input.returnUrl,
      type: 'account_onboarding',
    });
    return { url: link.url };
  }

  async getAccount(accountId: string): Promise<StripeAccountStatus> {
    const acct = await this.client.accounts.retrieve(accountId);
    return {
      chargesEnabled: acct.charges_enabled ?? false,
      payoutsEnabled: acct.payouts_enabled ?? false,
      detailsSubmitted: acct.details_submitted ?? false,
    };
  }

  async setPayoutSchedule(input: { accountId: string; delayDays: number }): Promise<void> {
    await this.client.accounts.update(input.accountId, {
      settings: {
        payouts: {
          /**
           * Always a DAILY schedule — zero delay means "no hold", not "no payouts".
           * `interval: 'manual'` would stop Stripe paying out altogether until something calls
           * payouts.create, and nothing in this codebase does. Mapping the top tier (delay 0) to
           * manual therefore froze the most-trusted sellers' money in their Connect balance
           * indefinitely — the exact opposite of the reward intended.
           */
          schedule: { interval: 'daily', delay_days: Math.max(0, input.delayDays) },
        },
      },
    });
  }

  async createDestinationCharge(input: DestinationChargeInput): Promise<{
    paymentIntentId: string;
    clientSecret: string | null;
    status: string;
    paymentMethodId?: string | null;
  }> {
    // Note: PaymentIntents do not take automatic_tax (that lives on Checkout/Invoices). Stripe Tax
    // for direct charges is computed via a Checkout Session or the Tax API — wired in a later phase.
    const customerId = input.customerRef
      ? (await this.ensureCustomer(input.customerRef)).customerId
      : undefined;

    /**
     * Off-session means: confirm NOW, against a card already on file, with nobody present. It is
     * what turns a scheduled instalment into an actual collection — an on-session intent just waits
     * for a human who is asleep. `error_on_requires_action` is deliberately NOT set: an SCA
     * challenge is a real outcome the caller must be able to see and act on, and collapsing it into
     * an exception would make it indistinguishable from a decline.
     */
    const offSession = Boolean(input.offSession && input.paymentMethodId);

    const intent = await this.client.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: input.currency,
        application_fee_amount: input.applicationFeeCents,
        transfer_data: { destination: input.destinationAccountId },
        transfer_group: input.transferGroup,
        metadata: input.metadata,
        ...(customerId ? { customer: customerId } : {}),
        // Keeps the card for later instalments. The payer is told this on the acceptance screen —
        // storing a credential silently is exactly what the network rules forbid.
        ...(input.savePaymentMethod ? { setup_future_usage: 'off_session' as const } : {}),
        ...(offSession
          ? {
              payment_method: input.paymentMethodId,
              off_session: true as const,
              confirm: true as const,
            }
          : {}),
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return {
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
      status: intent.status,
      paymentMethodId:
        typeof intent.payment_method === 'string'
          ? intent.payment_method
          : (intent.payment_method?.id ?? null),
    };
  }

  async ensureCustomer(customerRef: string, email?: string): Promise<{ customerId: string }> {
    return { customerId: await this.customerFor(customerRef, email) };
  }

  async createSetupIntent(input: {
    customerRef: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ setupIntentId: string; clientSecret: string | null; status: string }> {
    const customerId = await this.customerFor(input.customerRef);
    const intent = await this.client.setupIntents.create(
      {
        customer: customerId,
        // The card is being kept precisely so it can be charged when nobody is present.
        usage: 'off_session',
        metadata: input.metadata,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return {
      setupIntentId: intent.id,
      clientSecret: intent.client_secret,
      status: intent.status,
    };
  }

  async retrievePaymentMethod(
    id: string,
  ): Promise<{ brand: string | null; last4: string | null } | null> {
    const pm = await this.client.paymentMethods.retrieve(id);
    return { brand: pm.card?.brand ?? null, last4: pm.card?.last4 ?? null };
  }

  async retrieveSetupIntent(
    id: string,
  ): Promise<{ id: string; status: string; paymentMethodId?: string | null }> {
    const intent = await this.client.setupIntents.retrieve(id);
    return {
      id: intent.id,
      status: intent.status,
      paymentMethodId:
        typeof intent.payment_method === 'string'
          ? intent.payment_method
          : (intent.payment_method?.id ?? null),
    };
  }

  async createPlatformCharge(input: {
    amountCents: number;
    currency: string;
    transferGroup: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
    receiptEmail?: string;
  }): Promise<{ paymentIntentId: string; clientSecret: string | null; status: string }> {
    // Deliberately NO transfer_data / application_fee_amount: the money must settle on the platform
    // balance so settlement can split it three ways. See docs/consignment/RECOMMENDED_BUSINESS_MODEL.md.
    const intent = await this.client.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: input.currency,
        transfer_group: input.transferGroup,
        metadata: input.metadata,
        automatic_payment_methods: { enabled: true }, // wallets first (Apple/Google Pay)
        ...(input.receiptEmail ? { receipt_email: input.receiptEmail } : {}),
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return {
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
      status: intent.status,
    };
  }

  async retrievePaymentIntent(id: string): Promise<{
    id: string;
    status: string;
    amountCents: number;
    paymentMethodId?: string | null;
    clientSecret?: string | null;
  }> {
    const intent = await this.client.paymentIntents.retrieve(id);
    return {
      id: intent.id,
      status: intent.status,
      amountCents: intent.amount,
      paymentMethodId:
        typeof intent.payment_method === 'string'
          ? intent.payment_method
          : (intent.payment_method?.id ?? null),
      clientSecret: intent.client_secret,
    };
  }

  async createRefund(input: {
    paymentIntentId: string;
    amountCents?: number;
    reverseTransfer?: boolean;
    refundApplicationFee?: boolean;
    idempotencyKey: string;
  }): Promise<{ refundId: string }> {
    const refund = await this.client.refunds.create(
      {
        payment_intent: input.paymentIntentId,
        amount: input.amountCents,
        reverse_transfer: input.reverseTransfer,
        refund_application_fee: input.refundApplicationFee,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { refundId: refund.id };
  }

  async reverseTransfer(input: {
    transferId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<{ reversalId: string }> {
    const reversal = await this.client.transfers.createReversal(
      input.transferId,
      { amount: input.amountCents },
      { idempotencyKey: input.idempotencyKey },
    );
    return { reversalId: reversal.id };
  }

  async createTransfer(input: {
    amountCents: number;
    currency: string;
    destinationAccountId: string;
    transferGroup: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ transferId: string }> {
    const transfer = await this.client.transfers.create(
      {
        amount: input.amountCents,
        currency: input.currency,
        destination: input.destinationAccountId,
        transfer_group: input.transferGroup,
        metadata: input.metadata,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { transferId: transfer.id };
  }

  async createIdentitySession(input: {
    userId: string;
    returnUrl: string;
  }): Promise<{ sessionId: string; url: string | null; clientSecret: string | null }> {
    const session = await this.client.identity.verificationSessions.create({
      type: 'document',
      /**
       * Require the selfie match. Bronze is advertised as "Gov ID + selfie" and is the gate for
       * handling money, but the session was document-only — so nothing ever checked that the person
       * submitting the ID was the person ON it, which is the whole point of the liveness step. It
       * also meant the app's separate "Selfie liveness check" requirement could never be satisfied.
       */
      options: { document: { require_matching_selfie: true } },
      metadata: { userId: input.userId },
      return_url: input.returnUrl,
    });
    return {
      sessionId: session.id,
      url: session.url ?? null,
      clientSecret: session.client_secret ?? null,
    };
  }

  constructWebhookEvent(rawBody: Buffer, signature: string, secret: string): StripeWebhookEvent {
    const event = this.client.webhooks.constructEvent(rawBody, signature, secret);
    return {
      id: event.id,
      type: event.type,
      data: { object: event.data.object as unknown as Record<string, unknown> },
    };
  }

  async listBalanceTransactions(input: { limit?: number }): Promise<BalanceTxn[]> {
    const page = await this.client.balanceTransactions.list({ limit: input.limit ?? 100 });
    return page.data.map((t: Stripe.BalanceTransaction) => ({
      id: t.id,
      amountCents: t.amount,
      type: t.type,
      source:
        typeof t.source === 'string' ? t.source : t.source && 'id' in t.source ? t.source.id : null,
    }));
  }

  /**
   * One Stripe Product per plan, addressed by a deterministic id so it is created once and reused
   * forever. Subscription items take `product` — an id — and NOT `product_data`; the inline-product
   * shorthand only exists on Checkout Sessions and invoice items. Sending it here is rejected with
   * `parameter_unknown`, which is what made every upgrade fail at runtime.
   */
  private async planProductId(plan: string, name: string): Promise<string> {
    const id = `streetserve_plan_${plan}`;
    try {
      const existing = await this.client.products.retrieve(id);
      if (existing.active) return existing.id;
      const revived = await this.client.products.update(id, { active: true });
      return revived.id;
    } catch (err) {
      // Only "it isn't there yet" is recoverable by creating it; anything else is a real fault.
      if ((err as Stripe.errors.StripeError)?.code !== 'resource_missing') throw err;
      const created = await this.client.products.create({ id, name });
      return created.id;
    }
  }

  /**
   * A platform customer is looked up by our subscriber ref and reused. Creating one per attempt (as
   * this used to) left an orphan customer in Stripe behind every failed upgrade, and meant a
   * retrying subscriber accumulated duplicates that no longer shared a saved card.
   */
  private async customerFor(subscriberRef: string, email?: string): Promise<string> {
    const found = await this.client.customers.search({
      query: `metadata['subscriberRef']:'${subscriberRef}'`,
      limit: 1,
    });
    if (found.data[0]) return found.data[0].id;
    const created = await this.client.customers.create({
      metadata: { subscriberRef },
      ...(email ? { email } : {}),
    });
    return created.id;
  }

  async createSubscription(input: {
    customerRef: string;
    plan: string;
    planName: string;
    priceCents: number;
    idempotencyKey: string;
  }): Promise<{
    subscriptionId: string;
    status: string;
    currentPeriodEnd: number | null;
    clientSecret: string | null;
  }> {
    const [customerId, productId] = await Promise.all([
      this.customerFor(input.customerRef),
      this.planProductId(input.plan, input.planName),
    ]);

    const sub = await this.client.subscriptions.create(
      {
        customer: customerId,
        items: [
          {
            price_data: {
              currency: env.PLATFORM_CURRENCY,
              product: productId,
              unit_amount: input.priceCents,
              recurring: { interval: 'month' },
            },
          },
        ],
        /**
         * The subscriber has no card on file, so the subscription is deliberately created unpaid and
         * its first invoice's PaymentIntent is handed back for the client to confirm. Without this
         * the subscription still lands in `incomplete` — but silently, which is how an unpaid plan
         * could be mistaken for a paid one.
         */
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        expand: ['latest_invoice.payment_intent'],
        metadata: { subscriberRef: input.customerRef, plan: input.plan },
      },
      { idempotencyKey: input.idempotencyKey },
    );

    const invoice = sub.latest_invoice as Stripe.Invoice | null;
    const intent = invoice?.payment_intent as Stripe.PaymentIntent | null | undefined;
    return {
      subscriptionId: sub.id,
      status: sub.status,
      currentPeriodEnd: (sub as unknown as { current_period_end?: number }).current_period_end ?? null,
      clientSecret: intent?.client_secret ?? null,
    };
  }

  /** Re-reads the truth from Stripe after the client confirms payment. */
  async getSubscription(
    subscriptionId: string,
  ): Promise<{ status: string; currentPeriodEnd: number | null; cancelAtPeriodEnd: boolean }> {
    const sub = await this.client.subscriptions.retrieve(subscriptionId);
    return {
      status: sub.status,
      currentPeriodEnd: (sub as unknown as { current_period_end?: number }).current_period_end ?? null,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    };
  }

  async cancelSubscription(input: {
    subscriptionId: string;
    atPeriodEnd: boolean;
  }): Promise<{ status: string; cancelAtPeriodEnd: boolean }> {
    const sub = input.atPeriodEnd
      ? await this.client.subscriptions.update(input.subscriptionId, { cancel_at_period_end: true })
      : await this.client.subscriptions.cancel(input.subscriptionId);
    return { status: sub.status, cancelAtPeriodEnd: sub.cancel_at_period_end };
  }

  async getBalance(accountId: string): Promise<AccountBalance> {
    // Balance is read ON the connected account (Stripe-Account header), summed across currencies —
    // this platform is single-currency, so the first entry is the whole balance.
    const bal = await this.client.balance.retrieve({ stripeAccount: accountId });
    const sum = (rows: Stripe.Balance.Available[] | Stripe.Balance.Pending[]) =>
      rows.reduce((s, r) => s + r.amount, 0);
    return {
      availableCents: sum(bal.available),
      pendingCents: sum(bal.pending),
      currency: bal.available[0]?.currency ?? env.PLATFORM_CURRENCY,
    };
  }

  async getPlatformBalance(): Promise<AccountBalance> {
    // No Stripe-Account header — this is the platform's own balance, which funds every transfer.
    const bal = await this.client.balance.retrieve();
    const sum = (rows: Stripe.Balance.Available[] | Stripe.Balance.Pending[]) =>
      rows.reduce((s, r) => s + r.amount, 0);
    return {
      availableCents: sum(bal.available),
      pendingCents: sum(bal.pending),
      currency: bal.available[0]?.currency ?? env.PLATFORM_CURRENCY,
    };
  }
}

let cached: StripeConnectGateway | null = null;

export function buildRealGateway(): StripeGateway {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  cached ??= new StripeConnectGateway(env.STRIPE_SECRET_KEY);
  return cached;
}
