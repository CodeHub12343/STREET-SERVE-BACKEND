import { randomUUID } from 'node:crypto';

import type {
  ObjectHead,
  StorageGateway,
  UploadTarget,
} from '../src/integrations/storage';
import type {
  AccountBalance,
  BalanceTxn,
  CreateConnectedAccountInput,
  DestinationChargeInput,
  StripeAccountStatus,
  StripeGateway,
  StripeWebhookEvent,
} from '../src/integrations/stripe/types';

/**
 * In-memory Stripe gateway for tests: records calls, returns deterministic ids, and lets tests
 * flip account capabilities and feed balance transactions. No network, no real Stripe.
 */
export class FakeStripeGateway implements StripeGateway {
  private seq = 0;
  accounts = new Map<string, StripeAccountStatus>();
  charges: DestinationChargeInput[] = [];
  refunds: string[] = [];
  /** Rich refund records so tests can assert amount + R13 policy flags. */
  refundCalls: {
    paymentIntentId: string;
    amountCents?: number;
    reverseTransfer?: boolean;
    refundApplicationFee?: boolean;
  }[] = [];
  transfers: { amountCents: number; destination: string; transferId: string }[] = [];
  platformCharges: {
    paymentIntentId: string;
    amountCents: number;
    transferGroup: string;
    metadata: Record<string, string>;
  }[] = [];
  identitySessions: string[] = [];
  balance: BalanceTxn[] = [];
  accountBalances = new Map<string, AccountBalance>();
  payoutScheduleDelays: Record<string, number> = {};

  /**
   * Per-instance salt so ids are unique across fakes, not just within one.
   *
   * A bare counter restarts at 1 whenever a suite builds a fresh gateway per test, which reissues
   * `pi_1` and collides with any unique index on the intent id. Real Stripe never reuses an intent
   * id, so neither should the fake — the failure otherwise looks like a bug in the payment path.
   */
  private readonly salt = randomUUID().slice(0, 8);

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.salt}_${this.seq}`;
  }

  createConnectedAccount(_input: CreateConnectedAccountInput): Promise<{ accountId: string }> {
    const accountId = this.id('acct');
    this.accounts.set(accountId, {
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    });
    return Promise.resolve({ accountId });
  }

  createOnboardingLink(input: { accountId: string }): Promise<{ url: string }> {
    return Promise.resolve({ url: `https://connect.test/onboard/${input.accountId}` });
  }

  getAccount(accountId: string): Promise<StripeAccountStatus> {
    return Promise.resolve(
      this.accounts.get(accountId) ?? {
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
      },
    );
  }

  setPayoutSchedule(input: { accountId: string; delayDays: number }): Promise<void> {
    this.payoutScheduleDelays[input.accountId] = input.delayDays;
    return Promise.resolve();
  }

  /**
   * Cards the fake has "saved", and how an off-session charge against each should behave. Lets a
   * test model the three real outcomes of a scheduled instalment — collected, bank wants the
   * customer to authenticate, declined — which is the whole difficulty of recurring payments and
   * was previously unrepresentable here.
   */
  private offSessionOutcome = new Map<string, 'succeeded' | 'requires_action' | 'declined'>();

  /** Make the next off-session charge against this card behave a particular way. */
  setOffSessionOutcome(
    paymentMethodId: string,
    outcome: 'succeeded' | 'requires_action' | 'declined',
  ): void {
    this.offSessionOutcome.set(paymentMethodId, outcome);
  }

  createDestinationCharge(input: DestinationChargeInput): Promise<{
    paymentIntentId: string;
    clientSecret: string | null;
    status: string;
    paymentMethodId?: string | null;
  }> {
    this.charges.push(input);
    const paymentIntentId = this.id('pi');

    /**
     * An off-session charge CONFIRMS immediately, so its status is terminal — unlike the
     * on-session case below, where nothing has happened until a human enters a card.
     */
    if (input.offSession && input.paymentMethodId) {
      const outcome = this.offSessionOutcome.get(input.paymentMethodId) ?? 'succeeded';
      if (outcome === 'declined') {
        return Promise.reject(new Error('card_declined'));
      }
      this.intentStatus.set(paymentIntentId, outcome);
      return Promise.resolve({
        paymentIntentId,
        clientSecret: `cs_${paymentIntentId}`,
        status: outcome,
        paymentMethodId: input.paymentMethodId,
      });
    }

    /**
     * On-session. `savePaymentMethod` mirrors Stripe's `setup_future_usage`: the card does not
     * exist yet — it appears when the customer confirms — so it is recorded against the intent and
     * only surfaces through `retrievePaymentIntent`, exactly as the real flow does.
     */
    if (input.savePaymentMethod) {
      this.savedPaymentMethod.set(paymentIntentId, this.id('pm'));
    }
    return Promise.resolve({
      paymentIntentId,
      clientSecret: `cs_${paymentIntentId}`,
      status: 'requires_payment_method',
      paymentMethodId: null,
    });
  }

  private savedPaymentMethod = new Map<string, string>();

  ensureCustomer(customerRef: string): Promise<{ customerId: string }> {
    return Promise.resolve({ customerId: `cus_${customerRef}` });
  }

  /** Cards collected without a charge — the no-deposit agreement case. */
  private setupIntents = new Map<string, string>();

  createSetupIntent(input: {
    customerRef: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ setupIntentId: string; clientSecret: string | null; status: string }> {
    const setupIntentId = this.id('seti');
    // A card materialises when the customer confirms; the fake mints it up front and only reveals
    // it through `retrieveSetupIntent`, which is when the real flow can first see one.
    this.setupIntents.set(setupIntentId, this.id('pm'));
    return Promise.resolve({
      setupIntentId,
      clientSecret: `cs_${setupIntentId}`,
      status: 'requires_payment_method',
    });
  }

  retrievePaymentMethod(
    id: string,
  ): Promise<{ brand: string | null; last4: string | null } | null> {
    // Stable per id so a test can assert the schedule names the same card twice.
    return Promise.resolve({ brand: 'visa', last4: id.slice(-4).padStart(4, '4') });
  }

  retrieveSetupIntent(
    id: string,
  ): Promise<{ id: string; status: string; paymentMethodId?: string | null }> {
    return Promise.resolve({
      id,
      status: 'succeeded',
      paymentMethodId: this.setupIntents.get(id) ?? null,
    });
  }

  /** Separate charges + transfers: funds land on the platform balance, nothing is routed yet. */
  createPlatformCharge(input: {
    amountCents: number;
    currency: string;
    transferGroup: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
    receiptEmail?: string;
  }): Promise<{ paymentIntentId: string; clientSecret: string | null; status: string }> {
    const paymentIntentId = this.id('pi');
    this.platformCharges.push({
      paymentIntentId,
      amountCents: input.amountCents,
      transferGroup: input.transferGroup,
      metadata: input.metadata,
    });
    return Promise.resolve({
      paymentIntentId,
      clientSecret: `cs_${paymentIntentId}`,
      status: 'requires_payment_method',
    });
  }

  /**
   * Per-intent status overrides for the reconcile paths.
   *
   * `retrievePaymentIntent` used to answer `succeeded` unconditionally, which made every
   * reconcile-sweep test vacuous: a sweep that only ever sees settled money cannot demonstrate that
   * it leaves unsettled money alone, and "Stripe is authoritative" is untestable when the fake
   * Stripe has only one opinion. Default stays `succeeded` so existing callers are unchanged.
   */
  private intentStatus = new Map<string, string>();

  /** Mark an intent as settled at Stripe WITHOUT delivering a webhook — the missed-webhook case. */
  settleIntent(id: string): void {
    this.intentStatus.set(id, 'succeeded');
  }

  /** Anything Stripe can report: `requires_payment_method`, `canceled`, `processing`… */
  setIntentStatus(id: string, status: string): void {
    this.intentStatus.set(id, status);
  }

  retrievePaymentIntent(id: string): Promise<{
    id: string;
    status: string;
    amountCents: number;
    paymentMethodId?: string | null;
    clientSecret?: string | null;
  }> {
    const charge = this.platformCharges.find((c) => c.paymentIntentId === id);
    return Promise.resolve({
      id,
      status: this.intentStatus.get(id) ?? 'succeeded',
      amountCents: charge?.amountCents ?? 0,
      // Only present when the charge asked to keep the card — the same condition as real Stripe.
      paymentMethodId: this.savedPaymentMethod.get(id) ?? null,
      clientSecret: `cs_${id}`,
    });
  }

  createRefund(input: {
    paymentIntentId: string;
    amountCents?: number;
    reverseTransfer?: boolean;
    refundApplicationFee?: boolean;
  }): Promise<{ refundId: string }> {
    const refundId = this.id('re');
    this.refunds.push(input.paymentIntentId);
    this.refundCalls.push({
      paymentIntentId: input.paymentIntentId,
      amountCents: input.amountCents,
      reverseTransfer: input.reverseTransfer,
      refundApplicationFee: input.refundApplicationFee,
    });
    return Promise.resolve({ refundId });
  }

  /** Set a transfer id here to simulate a payee who has already spent the money. */
  unreversibleTransfers = new Set<string>();
  reversals: { transferId: string; amountCents: number; reversalId: string }[] = [];

  reverseTransfer(input: {
    transferId: string;
    amountCents: number;
  }): Promise<{ reversalId: string }> {
    if (this.unreversibleTransfers.has(input.transferId)) {
      return Promise.reject(new Error('Insufficient funds in the connected account'));
    }
    const reversalId = this.id('trr');
    this.reversals.push({ transferId: input.transferId, amountCents: input.amountCents, reversalId });
    return Promise.resolve({ reversalId });
  }

  createTransfer(input: {
    amountCents: number;
    destinationAccountId: string;
  }): Promise<{ transferId: string }> {
    const transferId = this.id('tr');
    this.transfers.push({
      amountCents: input.amountCents,
      destination: input.destinationAccountId,
      transferId,
    });
    return Promise.resolve({ transferId });
  }

  createIdentitySession(_input: {
    userId: string;
    returnUrl: string;
  }): Promise<{ sessionId: string; url: string | null; clientSecret: string | null }> {
    const sessionId = this.id('vs');
    this.identitySessions.push(sessionId);
    return Promise.resolve({
      sessionId,
      url: `https://verify.test/${sessionId}`,
      clientSecret: `cs_${sessionId}`,
    });
  }

  subscriptions: { subscriptionId: string; plan: string; status: string }[] = [];

  /**
   * The status new subscriptions are created with. Real Stripe returns `incomplete` for a customer
   * with no saved card — set this to reproduce that and assert the entitlement is withheld until
   * payment is confirmed. Defaults to `active` so the many suites that only care about the
   * downstream entitlement stay direct.
   */
  nextSubscriptionStatus = 'active';

  /** Every subscribe call as the service made it — lets tests assert the gateway got what it needs. */
  subscriptionInputs: { plan: string; planName?: string; priceCents: number }[] = [];

  /**
   * Move a subscription to a status Stripe would report on its own — a failed renewal becoming
   * `past_due`, dunning ending in `canceled`. Nothing in the app can produce those transitions, so
   * without this a test cannot reach the states the reconcile sweep exists to catch.
   */
  setSubscriptionStatus(subscriptionId: string, status: string): void {
    const sub = this.subscriptions.find((s) => s.subscriptionId === subscriptionId);
    if (sub) sub.status = status;
  }

  /** The id Stripe assigned to the Nth subscription created — webhooks arrive keyed on it. */
  lastSubscriptionId(): string | undefined {
    return this.subscriptions[this.subscriptions.length - 1]?.subscriptionId;
  }

  createSubscription(input: {
    plan: string;
    planName?: string;
    priceCents: number;
  }): Promise<{
    subscriptionId: string;
    status: string;
    currentPeriodEnd: number | null;
    clientSecret: string | null;
  }> {
    const subscriptionId = this.id('sub');
    const status = this.nextSubscriptionStatus;
    this.subscriptionInputs.push(input);
    this.subscriptions.push({ subscriptionId, plan: input.plan, status });
    return Promise.resolve({
      subscriptionId,
      status,
      currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      // An unpaid subscription hands back an intent to pay; a live one has nothing left to collect.
      clientSecret: status === 'incomplete' ? `pi_${subscriptionId}_secret` : null,
    });
  }

  /** Settles the subscription, as confirming the first invoice would. */
  getSubscription(
    subscriptionId: string,
  ): Promise<{ status: string; currentPeriodEnd: number | null; cancelAtPeriodEnd: boolean }> {
    const sub = this.subscriptions.find((s) => s.subscriptionId === subscriptionId);
    if (sub && sub.status === 'incomplete') sub.status = 'active';
    return Promise.resolve({
      status: sub?.status ?? 'incomplete',
      currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      cancelAtPeriodEnd: false,
    });
  }

  cancelSubscription(input: {
    subscriptionId: string;
    atPeriodEnd: boolean;
  }): Promise<{ status: string; cancelAtPeriodEnd: boolean }> {
    const sub = this.subscriptions.find((s) => s.subscriptionId === input.subscriptionId);
    if (sub && !input.atPeriodEnd) sub.status = 'canceled';
    return Promise.resolve({
      status: input.atPeriodEnd ? 'active' : 'canceled',
      cancelAtPeriodEnd: input.atPeriodEnd,
    });
  }

  // Tests pass the event JSON as the raw body; we just parse it (signature already "trusted").
  constructWebhookEvent(rawBody: Buffer): StripeWebhookEvent {
    return JSON.parse(rawBody.toString('utf8')) as StripeWebhookEvent;
  }

  listBalanceTransactions(): Promise<BalanceTxn[]> {
    return Promise.resolve(this.balance);
  }

  getBalance(accountId: string): Promise<AccountBalance> {
    return Promise.resolve(
      this.accountBalances.get(accountId) ?? { availableCents: 0, pendingCents: 0, currency: 'usd' },
    );
  }

  platformBalance: AccountBalance = { availableCents: 0, pendingCents: 0, currency: 'usd' };

  getPlatformBalance(): Promise<AccountBalance> {
    return Promise.resolve(this.platformBalance);
  }

  setPlatformBalance(availableCents: number, pendingCents = 0): void {
    this.platformBalance = { availableCents, pendingCents, currency: 'usd' };
  }

  setBalance(accountId: string, availableCents: number, pendingCents = 0): void {
    this.accountBalances.set(accountId, { availableCents, pendingCents, currency: 'usd' });
  }

  // ─── Test helpers ────────────────────────────────────────────────────────────────────────
  enableAccount(accountId: string): void {
    this.accounts.set(accountId, {
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });
  }

  lastCharge(): DestinationChargeInput | undefined {
    return this.charges[this.charges.length - 1];
  }
}

/**
 * In-memory object storage.
 *
 * Uploads normally go browser → R2 against a presigned URL, so the server never holds the bytes.
 * That makes anything which INSPECTS a file (pre-press validation) untestable without a stand-in
 * for the bucket itself. `put()` is the test's way of playing the browser's part.
 */
export class FakeStorageGateway implements StorageGateway {
  private objects = new Map<string, { bytes: Buffer; contentType: string }>();

  createUploadUrl(input: { prefix: string; contentType: string }): Promise<UploadTarget> {
    /**
     * A UUID, exactly as the real gateway does — not a per-instance counter.
     *
     * A counter looks fine until a suite constructs a fresh fake per test: it restarts at 1,
     * reissues a key an earlier test already stored, and the `storage_key` unique index rejects the
     * insert. The failure then looks like a bug in the upload path rather than in the fake.
     */
    const key = `${input.prefix}/${randomUUID()}`;
    return Promise.resolve({
      key,
      uploadUrl: `https://r2.test/put/${key}?ct=${encodeURIComponent(input.contentType)}`,
      publicUrl: `https://cdn.test/${key}`,
    });
  }

  /** Stand in for the client completing its PUT. */
  put(key: string, bytes: Buffer, contentType = 'application/octet-stream'): void {
    this.objects.set(key, { bytes, contentType });
  }

  /** The key most recently issued — saves tests reaching into the asset row for it. */
  lastKey(): string | null {
    const keys = [...this.objects.keys()];
    return keys[keys.length - 1] ?? null;
  }

  readObjectHead(
    key: string,
    maxBytes: number,
  ): Promise<{ head: ObjectHead; bytes: Buffer } | null> {
    const obj = this.objects.get(key);
    if (!obj) return Promise.resolve(null);
    return Promise.resolve({
      // Size is the FULL object even though the body is truncated, matching a ranged S3 response.
      head: { sizeBytes: obj.bytes.length, contentType: obj.contentType },
      bytes: obj.bytes.subarray(0, maxBytes),
    });
  }
}
