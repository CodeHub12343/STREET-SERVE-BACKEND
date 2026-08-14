/**
 * The narrow Stripe surface the app depends on. Everything money-related goes through this
 * interface so Stripe is swappable and fully mockable in tests (THIRD_PARTY_INTEGRATIONS.md §4).
 * Amounts are always integer cents.
 */
export interface CreateConnectedAccountInput {
  email?: string;
  country: string;
  metadata?: Record<string, string>;
}

export interface DestinationChargeInput {
  amountCents: number;
  currency: string;
  destinationAccountId: string;
  applicationFeeCents: number;
  transferGroup: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
  automaticTax?: boolean;
}

export interface StripeAccountStatus {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface BalanceTxn {
  id: string;
  amountCents: number;
  type: string;
  source: string | null;
}

export interface StripeGateway {
  createConnectedAccount(input: CreateConnectedAccountInput): Promise<{ accountId: string }>;
  createOnboardingLink(input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  getAccount(accountId: string): Promise<StripeAccountStatus>;
  setPayoutSchedule(input: { accountId: string; delayDays: number }): Promise<void>;

  createDestinationCharge(
    input: DestinationChargeInput,
  ): Promise<{ paymentIntentId: string; clientSecret: string | null; status: string }>;

  /**
   * SEPARATE CHARGES AND TRANSFERS (Phase 2). Funds land on the PLATFORM balance rather than being
   * routed to one connected account, so they can then be split N ways via `createTransfer`.
   * A destination charge cannot serve consignment: it pays exactly one account, and a consignment
   * sale must split three ways (platform fee / seller / hub).
   */
  createPlatformCharge(input: {
    amountCents: number;
    currency: string;
    transferGroup: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
    receiptEmail?: string;
  }): Promise<{ paymentIntentId: string; clientSecret: string | null; status: string }>;
  retrievePaymentIntent(id: string): Promise<{ id: string; status: string; amountCents: number }>;
  createRefund(input: {
    paymentIntentId: string;
    amountCents?: number;
    /** Pull the refunded amount back from the connected account (destination charge). */
    reverseTransfer?: boolean;
    /** Return the platform's application fee too (R13: fee returned pre-fulfillment / proportional). */
    refundApplicationFee?: boolean;
    idempotencyKey: string;
  }): Promise<{ refundId: string }>;

  /**
   * Pull money BACK from a connected account (Phase 4 refunds).
   *
   * `reverse_transfer` on a refund only works for DESTINATION charges. Consignment uses separate
   * charges and transfers, so each split leg must be reversed explicitly. Fails if the connected
   * account no longer holds the funds — the caller turns that into a clawback debt.
   */
  reverseTransfer(input: {
    transferId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<{ reversalId: string }>;

  /** Direct transfer from the platform balance to a connected account (settlement payout). */
  createTransfer(input: {
    amountCents: number;
    currency: string;
    destinationAccountId: string;
    transferGroup: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ transferId: string }>;

  createIdentitySession(input: {
    userId: string;
    returnUrl: string;
  }): Promise<{ sessionId: string; url: string | null; clientSecret: string | null }>;

  constructWebhookEvent(rawBody: Buffer, signature: string, secret: string): StripeWebhookEvent;
  listBalanceTransactions(input: { limit?: number }): Promise<BalanceTxn[]>;

  // ─── Subscriptions (monetization R29/R30) ──────────────────────────────────────────────────
  createSubscription(input: {
    customerRef: string; // our subscriber id (used as metadata / customer lookup key)
    plan: string;
    planName: string; // names the Stripe Product the plan's price hangs off
    priceCents: number;
    idempotencyKey: string;
  }): Promise<{
    subscriptionId: string;
    status: string;
    currentPeriodEnd: number | null;
    /**
     * The first invoice's PaymentIntent secret. The subscription is NOT paid until the client
     * confirms this, so entitlement must not be granted on the strength of the create call alone.
     */
    clientSecret: string | null;
  }>;
  /** Authoritative re-read, used to settle status once the client has confirmed payment. */
  getSubscription(
    subscriptionId: string,
  ): Promise<{ status: string; currentPeriodEnd: number | null; cancelAtPeriodEnd: boolean }>;
  cancelSubscription(input: {
    subscriptionId: string;
    atPeriodEnd: boolean;
  }): Promise<{ status: string; cancelAtPeriodEnd: boolean }>;

  /** A connected account's own balance — what's available to pay out vs still settling. */
  getBalance(accountId: string): Promise<AccountBalance>;
  /**
   * The PLATFORM's own balance (no connected account). Separate charges and transfers mean payouts
   * are funded from here, so monitoring it is what stops a payout failing for insufficient funds.
   */
  getPlatformBalance(): Promise<AccountBalance>;
}

export interface AccountBalance {
  availableCents: number;
  pendingCents: number;
  currency: string;
}
