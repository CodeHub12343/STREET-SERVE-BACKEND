import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel, CityModel } from '../src/modules/catalog/catalog.model';
import { setAgreementReviewedForTest } from '../src/modules/agreements/agreements.registry';
import { ConnectedAccountModel, TransactionModel } from '../src/modules/payments/payments.model';
import {
  RtoAgreementModel,
  RtoInstallmentModel,
  RtoLedgerEntryModel,
  RtoStatementEntryModel,
} from '../src/modules/rto/rto.model';
import { rtoService } from '../src/modules/rto/rto.service';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Rent-to-Own (R20–R27): approved seller + eligible product → customer accepts a disclosed
 * agreement → immutable schedule + ledger → installments charge with fee + ownership credit →
 * missed payment drives the state machine → early payoff uses the locked formula → completion
 * transfers ownership.
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();

/**
 * §60 — RTO acceptance is refused while the agreement is unreviewed placeholder text. These tests
 * exercise the flow BEHIND that gate, so they declare the agreements reviewed; the gate itself is
 * asserted directly in its own test below.
 */
let restoreReviewed: (() => void)[] = [];
beforeAll(async () => {
  setStripeGateway(fakeStripe);
  restoreReviewed = [
    setAgreementReviewedForTest('rto', true),
    setAgreementReviewedForTest('consignment_rto', true),
  ];
  await openRtoCity();
});
afterAll(() => restoreReviewed.forEach((r) => r()));

const RTO_CITY = 'rto-test-city';

/** §60.3 — RTO only runs in a live city whose `rto` flag is explicitly on. */
async function openRtoCity() {
  await CityModel.updateOne(
    { slug: RTO_CITY },
    {
      $set: { name: 'RTO Test City', state: 'CA', status: 'live', 'feature_flags.rto': true },
    },
    { upsert: true },
  );
}

function stripeEvent(type: string, object: Record<string, unknown>) {
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', 'test')
    .set('content-type', 'application/json')
    .send(JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } }));
}

/** A business with an enabled connected account, approved by an admin to offer RTO. */
async function approvedSeller(
  prefix: string,
): Promise<{ businessId: string; stripeAccountId: string; categoryId: string; vendorToken: string }> {
  const cat = await CategoryModel.create({
    slug: `${prefix}-cat`,
    name: prefix,
    top_level_tab: 'shopping',
    requires_license: false,
    // §43 is default-deny: a category is not offerable on RTO until an admin opens it.
    rto_eligible: true,
  });
  await seedUser({ authProviderId: `${prefix}|vendor`, roles: ['vendor'] });
  const vToken = await mintToken(`${prefix}|vendor`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(vToken))
    .send({ name: `${prefix} Store`, categoryId: String(cat._id) });
  const businessId = biz.body.data.id as string;
  await request(app).post(`/api/v1/businesses/${businessId}/payouts/onboard`).set(...bearer(vToken));
  const acct = await ConnectedAccountModel.findOne({ owner_type: 'business', owner_id: businessId }).lean();
  fakeStripe.enableAccount(acct!.stripe_account_id);
  await stripeEvent('account.updated', { id: acct!.stripe_account_id });

  await seedUser({ authProviderId: `${prefix}|admin`, roles: ['admin'] });
  const adminToken = await mintToken(`${prefix}|admin`);
  const approve = await request(app)
    .post('/api/v1/rto/approvals')
    .set(...bearer(adminToken))
    .send({ sellerId: businessId });
  expect(approve.status).toBe(201);
  return {
    businessId,
    stripeAccountId: acct!.stripe_account_id,
    categoryId: String(cat._id),
    vendorToken: vToken,
  };
}

/**
 * Publish an offer. Terms live on the LISTING, not on the customer's acceptance request — the whole
 * point of §42/§44 is that the seller states the deal and the customer only chooses to take it.
 */
async function publishListing(
  seller: { businessId: string; categoryId: string; vendorToken: string },
  terms: Record<string, unknown> = TERMS,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/rto/listings')
    .set(...bearer(seller.vendorToken))
    .send({
      sellerId: seller.businessId,
      productName: 'Refurb Laptop',
      categoryId: seller.categoryId,
      citySlug: RTO_CITY,
      quantityAvailable: 5,
      ...terms,
      ...extra,
    });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

/**
 * Confirm the card behind whatever payment an agreement is currently waiting on.
 *
 * `POST /rto/agreements` and `POST .../payoff` only OPEN a PaymentIntent. Nothing is credited, no
 * ledger entry is written and no ownership transfers until Stripe says the money arrived — so any
 * test that wants the PAID lifecycle has to settle the intent, exactly as a real customer confirming
 * their card would. A no-op when nothing is pending (a listing with no initial payment and no
 * set-up fee genuinely owes nothing on day one).
 */
async function settlePendingPayment(agreementId: string): Promise<boolean> {
  const row = await RtoAgreementModel.findById(agreementId).lean();
  const ref = row?.pending_intent_ref;
  if (!ref) return false;
  /**
   * An agreement with nothing due on day one collects a CARD rather than a payment, so the event
   * that settles it is `setup_intent.succeeded`. Both paths end with a card on file, which is what
   * the schedule needs — the difference is only whether money moved today.
   */
  const type =
    row?.pending_intent_kind === 'card_setup' ? 'setup_intent.succeeded' : 'payment_intent.succeeded';
  const res = await stripeEvent(type, { id: ref });
  expect(res.status).toBe(200);
  return true;
}

async function customer(prefix: string): Promise<string> {
  await seedUser({ authProviderId: `${prefix}|cust`, roles: ['customer'] });
  return mintToken(`${prefix}|cust`);
}

/** A business with a payout-enabled connected account (the consignment owner). */
async function payoutEnabledBusiness(prefix: string): Promise<string> {
  const cat = await CategoryModel.create({
    slug: `${prefix}-ocat`,
    name: prefix,
    top_level_tab: 'shopping',
    requires_license: false,
  });
  await seedUser({ authProviderId: `${prefix}|owner`, roles: ['vendor'] });
  const token = await mintToken(`${prefix}|owner`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(token))
    .send({ name: `${prefix} Owner`, categoryId: String(cat._id) });
  const businessId = biz.body.data.id as string;
  await request(app).post(`/api/v1/businesses/${businessId}/payouts/onboard`).set(...bearer(token));
  const acct = await ConnectedAccountModel.findOne({ owner_type: 'business', owner_id: businessId }).lean();
  fakeStripe.enableAccount(acct!.stripe_account_id);
  await stripeEvent('account.updated', { id: acct!.stripe_account_id });
  return businessId;
}

const TERMS = {
  cashPriceCents: 10000,
  initialPaymentCents: 2000,
  installmentCount: 4,
  frequency: 'weekly' as const,
  markupBps: 1000, // 10% rental markup → $110 total to own
};

/** Terms that make each installment exactly $100: cash $400, no initial, 4 weekly, no markup. */
const HUNDRED_A_WEEK = {
  cashPriceCents: 40000,
  initialPaymentCents: 0,
  installmentCount: 4,
  frequency: 'weekly' as const,
  markupBps: 0,
};

/** §54's ten allocations — required on every consignment RTO, so every fixture has to state them. */
const CONSIGNMENT_TERMS = {
  ownerDuringTerm: 'owner' as const,
  deliveryBy: 'seller' as const,
  returnsManagedBy: 'seller' as const,
  customerSupportBy: 'seller' as const,
  damageResponsibility: 'customer' as const,
  missedPaymentsHandledBy: 'seller' as const,
  earlyPayoffApprovedBy: 'owner' as const,
  onCustomerReturn: 'owner' as const,
  ownershipTransfersAt: 'either' as const,
  paymentDivisionNote: 'Owner 63%, managing business 27%, platform 10% of each payment.',
};

describe('RTO disclosure + acceptance (R20/R21/R26)', () => {
  it('discloses the full cost incl. the "more than buying outright" delta', async () => {
    await approvedSeller('rto-disc'); // ensures RTO feature path is exercised
    const token = await customer('rto-disc');
    const res = await request(app)
      .post('/api/v1/rto/disclose')
      .set(...bearer(token))
      .send(TERMS);
    expect(res.status).toBe(200);
    expect(res.body.data.totalToOwnCents).toBe(11000);
    expect(res.body.data.costOverCashCents).toBe(1000);
    expect(res.body.data.schedule).toHaveLength(4);
    expect(res.body.data.disclosure).toMatch(/more than/);
  });

  it('accepts, locks an immutable schedule, and opens ONE charge for the initial payment + set-up fee', async () => {
    const seller = await approvedSeller('rto-accept');
    const listingId = await publishListing(seller, { ...TERMS, setupFeeCents: 500 });
    const token = await customer('rto-accept');
    const res = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-accept-1')
      .send({ listingId });
    expect(res.status).toBe(201);
    const agreementId = res.body.data.id as string;
    expect(res.body.data.totalToOwnCents).toBe(11000);

    /**
     * ═══ Nothing is owned yet. This is the whole point. ═══
     *
     * Acceptance used to credit the initial payment's equity into the agreement and mark the
     * transaction complete, having only OPENED a PaymentIntent — so a customer who never entered a
     * card walked away owning 20% of a laptop. Until the webhook lands, the answer is zero.
     */
    expect(res.body.data.ownershipCreditedCents).toBe(0);
    expect(res.body.data.ownershipPercent).toBe(0);

    // Both amounts due today arrive as ONE intent — one decision, one card form.
    expect(res.body.data.amountDueNowCents).toBe(2500); // 2000 initial + 500 set-up
    expect(res.body.data.clientSecret).toEqual(expect.any(String));

    const schedule = await RtoInstallmentModel.find({ agreement_id: agreementId }).lean();
    expect(schedule).toHaveLength(4);
    expect(schedule.reduce((s, r) => s + r.ownership_credit_cents, 0)).toBe(8000); // + 2000 initial = cash

    // The ledger is the MONEY record. Nothing may be in it while the card is unconfirmed.
    expect(await RtoLedgerEntryModel.countDocuments({ agreement_id: agreementId })).toBe(0);

    // ── The card clears. Now, and only now, everything lands. ──
    expect(await settlePendingPayment(agreementId)).toBe(true);

    const dash = await request(app).get(`/api/v1/rto/agreements/${agreementId}`).set(...bearer(token));
    expect(dash.body.data.ownershipCreditedCents).toBe(2000);
    expect(dash.body.data.ownershipPercent).toBe(20);

    const ledger = await RtoLedgerEntryModel.find({ agreement_id: agreementId }).lean();
    const initial = ledger.find((l) => l.entry_type === 'initial');
    const setup = ledger.find((l) => l.entry_type === 'setup_fee');
    expect(initial!.amount_cents).toBe(2000);
    expect(initial!.ownership_credit_cents).toBe(2000);
    expect(initial!.fee_cents).toBe(200); // 10% of the 2000 initial — never of the set-up fee
    expect(setup!.amount_cents).toBe(500);
    // A set-up fee is a cost, not progress toward owning the thing.
    expect(setup!.ownership_credit_cents).toBe(0);

    // Both ledger lines reference the one transaction, and that transaction is now settled.
    expect(initial!.transaction_id).toBe(setup!.transaction_id);
    const txn = await TransactionModel.findById(initial!.transaction_id).lean();
    expect(txn!.status).toBe('completed');
  });

  /**
   * ═══ THE REGRESSION. ═══
   *
   * `accept` called `paymentsService.charge()` and then `completeForOrder()` on the next line, which
   * marks a transaction `completed` without anything having been confirmed. Every downstream fact
   * followed from that lie: ownership credited, an immutable ledger entry asserting money had moved,
   * a consignment statement crediting the owner their share.
   *
   * This test states the invariant directly, so no future shortcut can quietly restore it: with no
   * webhook, the customer owns NOTHING, the ledger is empty, no transaction is completed, and the
   * instalment sweep will not bill them either.
   */
  it('credits no ownership, and writes no ledger, without a completed transaction', async () => {
    const seller = await approvedSeller('rto-nopay');
    const listingId = await publishListing(seller);
    const token = await customer('rto-nopay');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-nopay-1')
      .send({ listingId });
    expect(accept.status).toBe(201);
    const agreementId = accept.body.data.id as string;
    // Deliberately no `settlePendingPayment` here — this test IS the unpaid case.

    const row = await RtoAgreementModel.findById(agreementId).lean();
    expect(row!.ownership_credited_cents).toBe(0);
    expect(row!.pending_intent_kind).toBe('acceptance');
    expect(await RtoLedgerEntryModel.countDocuments({ agreement_id: agreementId })).toBe(0);
    // Not one statement line either — an owner must not be credited a share of money never taken.
    expect(await RtoStatementEntryModel.countDocuments({ agreement_id: agreementId })).toBe(0);
    expect(
      await TransactionModel.countDocuments({ customer_id: row!.customer_id, status: 'completed' }),
    ).toBe(0);

    /**
     * And the schedule does not start running. Billing instalment #1 against someone whose very
     * first payment is still unconfirmed would charge them for an agreement they have not entered —
     * and a decline would drop them into Grace on a schedule that never legitimately began.
     */
    await RtoInstallmentModel.updateOne(
      { agreement_id: agreementId, installment_number: 1 },
      { $set: { due_at: new Date(Date.now() - 60_000) } },
    );
    await rtoService.chargeDueInstallments();
    const inst = await RtoInstallmentModel.findOne({
      agreement_id: agreementId,
      installment_number: 1,
    }).lean();
    expect(inst!.status).toBe('scheduled');

    // Early payoff is refused for the same reason — it would credit ownership to FULL on an
    // unpaid agreement, which is the original defect through a different door.
    const payoff = await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/payoff`)
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-nopay-payoff')
      .send({});
    expect(payoff.status).toBe(409);
  });

  /**
   * ═══ The webhook is now load-bearing, so a lost one has to be survivable. ═══
   *
   * Ownership, the ledger, the split and the ownership transfer all hang off
   * `payment_intent.succeeded`. That is the right design, and it makes a dropped event expensive in
   * a way it never was before: the customer has paid their deposit, owns nothing, and their
   * schedule stays frozen by the sweep guard — silently, with nothing on any screen to show it.
   */
  it('settles an acceptance whose webhook never arrived', async () => {
    const seller = await approvedSeller('rto-losthook');
    const listingId = await publishListing(seller);
    const token = await customer('rto-losthook');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-losthook-1')
      .send({ listingId });
    const agreementId = accept.body.data.id as string;

    // The card clears at Stripe. The event never reaches us.
    expect((await RtoAgreementModel.findById(agreementId).lean())!.ownership_credited_cents).toBe(0);

    // Age it past the grace period so the sweep stops treating it as in flight.
    await RtoAgreementModel.collection.updateOne(
      { _id: (await RtoAgreementModel.findById(agreementId).lean())!._id },
      { $set: { updated_at: new Date(Date.now() - 3_600_000) } },
    );

    const swept = await rtoService.reconcilePendingIntents();
    expect(swept.settled).toBeGreaterThanOrEqual(1);

    const row = await RtoAgreementModel.findById(agreementId).lean();
    expect(row!.ownership_credited_cents).toBe(2000);
    expect(row!.pending_intent_ref).toBeNull();
    // And the card was captured, so the schedule can run.
    expect(row!.payment_method_ref).toEqual(expect.any(String));
    expect(
      await RtoLedgerEntryModel.countDocuments({ agreement_id: agreementId, entry_type: 'initial' }),
    ).toBe(1);

    // Idempotent: a webhook that turns up late, or a second sweep, credits nothing further.
    await rtoService.reconcilePendingIntents();
    expect(
      (await RtoAgreementModel.findById(agreementId).lean())!.ownership_credited_cents,
    ).toBe(2000);
  });

  /** An intent still awaiting a card is in flight, not lost. The sweep must not race the webhook. */
  it('leaves an unpaid agreement alone', async () => {
    const seller = await approvedSeller('rto-inflight');
    const listingId = await publishListing(seller);
    const token = await customer('rto-inflight');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-inflight-1')
      .send({ listingId });
    const agreementId = accept.body.data.id as string;

    const ref = (await RtoAgreementModel.findById(agreementId).lean())!.pending_intent_ref!;
    fakeStripe.setIntentStatus(ref, 'requires_payment_method');
    await RtoAgreementModel.collection.updateOne(
      { _id: (await RtoAgreementModel.findById(agreementId).lean())!._id },
      { $set: { updated_at: new Date(Date.now() - 3_600_000) } },
    );

    await rtoService.reconcilePendingIntents();

    const row = await RtoAgreementModel.findById(agreementId).lean();
    expect(row!.ownership_credited_cents).toBe(0);
    expect(row!.pending_intent_ref).toBe(ref); // still waiting, not written off
  });

  /** A webhook is delivered at least once — twice must not mean twice the equity. */
  it('credits an acceptance exactly once, however many times Stripe delivers it', async () => {
    const seller = await approvedSeller('rto-dupe');
    const listingId = await publishListing(seller);
    const token = await customer('rto-dupe');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-dupe-1')
      .send({ listingId });
    const agreementId = accept.body.data.id as string;

    // Delivered twice, by hand — not via the settle helper, whose whole job is to fire it once.
    const ref = (await RtoAgreementModel.findById(agreementId).lean())!.pending_intent_ref!;
    await stripeEvent('payment_intent.succeeded', { id: ref });
    await stripeEvent('payment_intent.succeeded', { id: ref });

    const row = await RtoAgreementModel.findById(agreementId).lean();
    expect(row!.ownership_credited_cents).toBe(2000); // not 4000
    expect(
      await RtoLedgerEntryModel.countDocuments({ agreement_id: agreementId, entry_type: 'initial' }),
    ).toBe(1);
  });
});

/**
 * ═══ THE RECURRING RAIL. ═══
 *
 * A Rent-to-Own agreement is twelve scheduled payments, and every one falls due when nobody is
 * looking at a screen. `chargeDueInstallments` opened an ordinary ON-SESSION PaymentIntent for each
 * — an intent that waits for a human to type a card — and then marked it complete. So even with
 * acceptance and payoff fixed, the schedule the seller set could never collect a penny: the state
 * machine, the grace period, the late fees and the disclosure were all sitting on a rail with no
 * way to take money.
 *
 * The fix is stored credentials: keep the card at acceptance (the one moment the customer is
 * present), then charge off-session. These tests pin the three outcomes that rail actually has.
 */
describe('RTO instalments are collected off-session from a saved card', () => {
  it('saves the card at acceptance and charges the schedule against it', async () => {
    const seller = await approvedSeller('rto-offsession');
    const listingId = await publishListing(seller, TERMS, { productName: 'Fridge' });
    const token = await customer('rto-offsession');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-offsession-1')
      .send({ listingId });
    const agreementId = accept.body.data.id as string;

    // Before the card is confirmed there is nothing to charge against.
    expect((await RtoAgreementModel.findById(agreementId).lean())!.payment_method_ref).toBeNull();

    await settlePendingPayment(agreementId);

    // The card the customer entered is now on file, purely so the schedule can run itself.
    const saved = (await RtoAgreementModel.findById(agreementId).lean())!.payment_method_ref;
    expect(saved).toEqual(expect.any(String));

    await RtoInstallmentModel.updateOne(
      { agreement_id: agreementId, installment_number: 1 },
      { $set: { due_at: new Date(Date.now() - 60_000) } },
    );
    await rtoService.chargeDueInstallments();

    // Charged with nobody present, against the saved card — the thing that could not happen before.
    const offSession = fakeStripe.charges.filter((c) => c.offSession);
    expect(offSession.length).toBeGreaterThanOrEqual(1);
    expect(offSession.at(-1)!.paymentMethodId).toBe(saved);

    const inst = await RtoInstallmentModel.findOne({
      agreement_id: agreementId,
      installment_number: 1,
    }).lean();
    expect(inst!.status).toBe('paid');
  });

  /**
   * An SCA challenge is the bank asking the customer to approve a payment. Their card is fine and
   * they have done nothing wrong — so it must never touch the delinquency machinery. Treating it as
   * a decline would push someone into Grace, then Late, then toward recovery of the goods, for
   * their bank's security policy.
   */
  it('treats an authentication request as needing the customer, never as a missed payment', async () => {
    const seller = await approvedSeller('rto-sca');
    const listingId = await publishListing(seller, TERMS, { productName: 'Oven' });
    const token = await customer('rto-sca');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-sca-1')
      .send({ listingId });
    const agreementId = accept.body.data.id as string;
    await settlePendingPayment(agreementId);

    const saved = (await RtoAgreementModel.findById(agreementId).lean())!.payment_method_ref!;
    fakeStripe.setOffSessionOutcome(saved, 'requires_action');

    await RtoInstallmentModel.updateOne(
      { agreement_id: agreementId, installment_number: 1 },
      { $set: { due_at: new Date(Date.now() - 60_000) } },
    );
    await rtoService.chargeDueInstallments();

    const row = await RtoAgreementModel.findById(agreementId).lean();
    expect(row!.status).toBe('active'); // not grace
    expect(row!.action_required_installment).toBe(1);
    // The intent lives on the unified pending ref, which is what the webhook actually reads.
    expect(row!.pending_intent_kind).toBe('installment');
    expect(row!.pending_intent_ref).toEqual(expect.any(String));
    // The instalment is still owed, not written off as failed.
    const inst = await RtoInstallmentModel.findOne({
      agreement_id: agreementId,
      installment_number: 1,
    }).lean();
    expect(inst!.status).toBe('scheduled');

    // And the customer can finish it — against the SAME intent, so the money is not taken twice.
    const resume = await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/pay-installment`)
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-sca-resume')
      .send({});
    expect(resume.status).toBe(200);
    expect(resume.body.data.clientSecret).toEqual(expect.any(String));
    expect(resume.body.data.installmentNumber).toBe(1);
  });

  /**
   * No card on file — an agreement accepted before stored credentials existed, or one whose
   * acceptance settled without a reusable card. That is OUR failure, so the customer must not be
   * marked late, charged a fee, or moved a step closer to losing the goods for it.
   */
  it('asks for a card rather than marking the customer late when none is saved', async () => {
    const seller = await approvedSeller('rto-nocard');
    const listingId = await publishListing(seller, TERMS, { productName: 'Desk' });
    const token = await customer('rto-nocard');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-nocard-1')
      .send({ listingId });
    const agreementId = accept.body.data.id as string;
    await settlePendingPayment(agreementId);

    // The card goes away (a pre-existing agreement, or a capture that failed).
    await RtoAgreementModel.updateOne(
      { _id: agreementId },
      { $set: { payment_method_ref: null } },
    );
    await RtoInstallmentModel.updateOne(
      { agreement_id: agreementId, installment_number: 1 },
      { $set: { due_at: new Date(Date.now() - 60_000) } },
    );

    await rtoService.chargeDueInstallments();

    const row = await RtoAgreementModel.findById(agreementId).lean();
    expect(row!.status).toBe('active');
    expect(row!.action_required_installment).toBe(1);
    // No late fee for a card WE failed to keep.
    expect(row!.late_fees_assessed_cents ?? 0).toBe(0);

    // Resuming opens a fresh on-session charge AND saves the card, so the schedule self-heals.
    const resume = await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/pay-installment`)
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-nocard-resume')
      .send({});
    expect(resume.status).toBe(200);
    expect(resume.body.data.clientSecret).toEqual(expect.any(String));
    expect(fakeStripe.charges.at(-1)!.savePaymentMethod).toBe(true);
  });

  /**
   * ═══ Paying an instalment by hand must actually credit it. ═══
   *
   * Two things at once. First, the product had no way to pay an instalment early at all: the screen
   * showed "0/12 payments made · next due 23 Aug" and offered nothing but a full payoff, so a
   * customer who wanted to clear one could not.
   *
   * Second, the intent for a hand-paid instalment used to be stored on a field of its own that
   * `creditByPaymentIntent` never read — so the SCA and no-card recovery paths took the money and
   * credited nothing: no ledger entry, no ownership, the instalment still showing as scheduled. It
   * now rides the same `pending_intent_ref` rail as everything else.
   */
  it('lets a customer pay the next instalment early, and credits it', async () => {
    const seller = await approvedSeller('rto-payearly');
    const listingId = await publishListing(seller, TERMS, { productName: 'Mixer' });
    const token = await customer('rto-payearly');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-payearly-1')
      .send({ listingId });
    const agreementId = accept.body.data.id as string;
    await settlePendingPayment(agreementId);

    const before = await request(app)
      .get(`/api/v1/rto/agreements/${agreementId}`)
      .set(...bearer(token));
    expect(before.body.data.installmentsPaid).toBe(0);
    // The screen can now say WHAT is next and WHICH card it comes off.
    expect(before.body.data.nextInstallment.installmentNumber).toBe(1);
    expect(before.body.data.nextInstallment.amountCents).toBeGreaterThan(0);
    expect(before.body.data.savedCard.last4).toEqual(expect.any(String));

    // Nothing is due yet — this is paying AHEAD, which had no path before.
    const pay = await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/pay-installment`)
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-payearly-pay')
      .send({});
    expect(pay.status).toBe(200);
    expect(pay.body.data.installmentNumber).toBe(1);
    expect(pay.body.data.clientSecret).toEqual(expect.any(String));

    // Still uncredited until the card clears — same rule as everywhere else.
    expect((await RtoAgreementModel.findById(agreementId).lean())!.installments_paid ?? 0).toBe(0);

    await settlePendingPayment(agreementId);

    const after = await request(app)
      .get(`/api/v1/rto/agreements/${agreementId}`)
      .set(...bearer(token));
    expect(after.body.data.installmentsPaid).toBe(1);
    expect(after.body.data.ownershipCreditedCents).toBe(4000); // 2000 initial + 2000 instalment
    expect(
      await RtoLedgerEntryModel.countDocuments({
        agreement_id: agreementId,
        entry_type: 'installment',
      }),
    ).toBe(1);
    expect(
      (await RtoInstallmentModel.findOne({ agreement_id: agreementId, installment_number: 1 }).lean())!
        .status,
    ).toBe('paid');

    // The schedule has moved on rather than re-offering the one just paid.
    expect(after.body.data.nextInstallment.installmentNumber).toBe(2);
  });

  /** Asking twice must hand back the SAME intent, never open a second charge for one instalment. */
  it('does not open a second charge when a payment is already in flight', async () => {
    const seller = await approvedSeller('rto-twice');
    const listingId = await publishListing(seller, TERMS, { productName: 'Lamp' });
    const token = await customer('rto-twice');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-twice-1')
      .send({ listingId });
    const agreementId = accept.body.data.id as string;
    await settlePendingPayment(agreementId);

    const first = await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/pay-installment`)
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-twice-a')
      .send({});
    const second = await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/pay-installment`)
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-twice-b')
      .send({});

    expect(second.status).toBe(200);
    expect(second.body.data.installmentNumber).toBe(first.body.data.installmentNumber);
    // One intent on the agreement, not two charges racing for one instalment.
    const row = await RtoAgreementModel.findById(agreementId).lean();
    expect(row!.pending_intent_installment).toBe(1);
  });

  /** A genuine decline still drives the R22 state machine exactly as before. */
  it('still drives Missed → Grace when the saved card is actually declined', async () => {
    const seller = await approvedSeller('rto-decline');
    const listingId = await publishListing(seller, TERMS, { productName: 'Chair' });
    const token = await customer('rto-decline');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-decline-1')
      .send({ listingId });
    const agreementId = accept.body.data.id as string;
    await settlePendingPayment(agreementId);

    const saved = (await RtoAgreementModel.findById(agreementId).lean())!.payment_method_ref!;
    fakeStripe.setOffSessionOutcome(saved, 'declined');

    await RtoInstallmentModel.updateOne(
      { agreement_id: agreementId, installment_number: 1 },
      { $set: { due_at: new Date(Date.now() - 60_000) } },
    );
    await rtoService.chargeDueInstallments();
    expect((await RtoAgreementModel.findById(agreementId).lean())!.status).toBe('grace');
  });
});

describe('RTO installments + payoff + completion (R21/R23/R25)', () => {
  it('charges a due installment with fee + ownership credit, then payoff completes + transfers ownership', async () => {
    const seller = await approvedSeller('rto-life');
    const listingId = await publishListing(seller, TERMS, { productName: 'Bike' });
    const token = await customer('rto-life');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-life-1')
      .send({ listingId });
    const agreementId = accept.body.data.id as string;
    await settlePendingPayment(agreementId); // the deposit clears — the schedule may now run

    // Make installment #1 due, then run the charge sweep.
    await RtoInstallmentModel.updateOne(
      { agreement_id: agreementId, installment_number: 1 },
      { $set: { due_at: new Date(Date.now() - 60_000) } },
    );
    const swept = await rtoService.chargeDueInstallments();
    expect(swept.charged).toBeGreaterThanOrEqual(1);

    const dash1 = await request(app).get(`/api/v1/rto/agreements/${agreementId}`).set(...bearer(token));
    expect(dash1.body.data.installmentsPaid).toBe(1);
    expect(dash1.body.data.ownershipCreditedCents).toBe(4000); // 2000 initial + 2000 installment
    // Payoff is the locked remaining equity: cash 10000 − 4000 credited = 6000.
    expect(dash1.body.data.payoffCents).toBe(6000);

    const inst1 = await RtoInstallmentModel.findOne({ agreement_id: agreementId, installment_number: 1 }).lean();
    expect(inst1!.status).toBe('paid');
    const ledgerInst = await RtoLedgerEntryModel.findOne({ agreement_id: agreementId, entry_type: 'installment' }).lean();
    expect(ledgerInst!.fee_cents).toBe(225); // 10% of the 2250 installment

    /**
     * Early payoff (R23) using the locked formula. It OPENS a charge and hands back a secret —
     * `completed` is false, because ownership has not transferred and saying it had is precisely
     * what this path used to do while nobody had paid.
     */
    const payoff = await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/payoff`)
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-life-payoff')
      .send({});
    expect(payoff.status).toBe(200);
    expect(payoff.body.data.payoffCents).toBe(6000);
    expect(payoff.body.data.completed).toBe(false);
    expect(payoff.body.data.clientSecret).toEqual(expect.any(String));

    // Still theirs to finish paying: no proof of ownership issued against an unconfirmed card.
    const midway = await request(app).get(`/api/v1/rto/agreements/${agreementId}`).set(...bearer(token));
    expect(midway.body.data.status).not.toBe('completed');
    expect(midway.body.data.proofOfOwnership).toBeNull();

    // ── The card clears → ownership transfers (R25). ──
    expect(await settlePendingPayment(agreementId)).toBe(true);
    expect(
      (await RtoLedgerEntryModel.findOne({ agreement_id: agreementId, entry_type: 'payoff' }).lean())!
        .amount_cents,
    ).toBe(6000);

    const dash2 = await request(app).get(`/api/v1/rto/agreements/${agreementId}`).set(...bearer(token));
    expect(dash2.body.data.status).toBe('completed');
    expect(dash2.body.data.ownershipPercent).toBe(100);
    expect(dash2.body.data.proofOfOwnership).toEqual(expect.any(String));
  });

  it('a failed installment charge drives the state machine: Missed → Grace → Late (R22)', async () => {
    const seller = await approvedSeller('rto-miss');
    const { stripeAccountId } = seller;
    const listingId = await publishListing(seller, TERMS, { productName: 'Sofa' });
    const token = await customer('rto-miss');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-miss-1')
      .send({ listingId });
    const agreementId = accept.body.data.id as string;
    await settlePendingPayment(agreementId); // the deposit clears — the schedule may now run

    // Disable the seller's account so the installment charge fails.
    await ConnectedAccountModel.updateOne({ stripe_account_id: stripeAccountId }, { $set: { charges_enabled: false } });
    await RtoInstallmentModel.updateOne(
      { agreement_id: agreementId, installment_number: 1 },
      { $set: { due_at: new Date(Date.now() - 60_000) } },
    );
    const swept = await rtoService.chargeDueInstallments();
    expect(swept.missed).toBeGreaterThanOrEqual(1);

    const dash = await request(app).get(`/api/v1/rto/agreements/${agreementId}`).set(...bearer(token));
    expect(dash.body.data.status).toBe('grace');

    // Push the missed installment past the grace window → Late.
    await RtoInstallmentModel.updateOne(
      { agreement_id: agreementId, installment_number: 1 },
      { $set: { due_at: new Date(Date.now() - 60 * 86_400_000) } },
    );
    const escalated = await rtoService.sweepDelinquency();
    expect(escalated).toBeGreaterThanOrEqual(1);
    const dash2 = await request(app).get(`/api/v1/rto/agreements/${agreementId}`).set(...bearer(token));
    expect(dash2.body.data.status).toBe('late');
  });

  /**
   * §49/§50 — the disclosed late fee is actually assessed. Found by the A-2 reachability gate: the
   * ledger declared a `late_fee` entry type that nothing ever wrote, while `late_fee_cents` was a
   * seller-set term shown to the customer before they accepted. A fee that is disclosed and never
   * charged is a term the product does not honour.
   */
  it('assesses the disclosed late fee once on Grace → Late, as owed and not as equity (§49/§50)', async () => {
    const seller = await approvedSeller('rto-latefee');
    const { stripeAccountId } = seller;
    const listingId = await publishListing(seller, { ...TERMS, lateFeeCents: 1500 }, {
      productName: 'Late Fee Sofa',
    });
    const token = await customer('rto-latefee');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-latefee-1')
      .send({ listingId });
    const agreementId = accept.body.data.id as string;
    await settlePendingPayment(agreementId); // the deposit clears — the schedule may now run

    await ConnectedAccountModel.updateOne(
      { stripe_account_id: stripeAccountId },
      { $set: { charges_enabled: false } },
    );
    await RtoInstallmentModel.updateOne(
      { agreement_id: agreementId, installment_number: 1 },
      { $set: { due_at: new Date(Date.now() - 60 * 86_400_000) } },
    );
    await rtoService.chargeDueInstallments();
    await rtoService.sweepDelinquency();

    const fees = await RtoLedgerEntryModel.find({
      agreement_id: agreementId,
      entry_type: 'late_fee',
    }).lean();
    expect(fees).toHaveLength(1);
    expect(fees[0]!.amount_cents).toBe(1500);
    // A penalty must never move the customer closer to owning the item.
    expect(fees[0]!.ownership_credit_cents).toBe(0);
    // The platform takes no cut of a penalty — it is the seller's remedy, not platform revenue.
    expect(fees[0]!.fee_cents).toBe(0);

    // Idempotent: re-running the sweep must not stack a second fee on the same missed installment.
    await rtoService.sweepDelinquency();
    expect(
      await RtoLedgerEntryModel.countDocuments({ agreement_id: agreementId, entry_type: 'late_fee' }),
    ).toBe(1);

    // Recorded as owed, never auto-charged: a customer who just failed a payment does not get a
    // second charge attempt for the penalty.
    const agreement = await RtoAgreementModel.findById(agreementId).lean();
    expect(agreement!.late_fees_assessed_cents).toBe(1500);
    expect(fees[0]!.transaction_id).toBeNull();
  });

  it('assesses no late fee when the listing sets none (the default)', async () => {
    const seller = await approvedSeller('rto-nolatefee');
    const listingId = await publishListing(seller, TERMS, { productName: 'No Fee Sofa' });
    const token = await customer('rto-nolatefee');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-nolatefee-1')
      .send({ listingId });
    const agreementId = accept.body.data.id as string;
    await settlePendingPayment(agreementId); // the deposit clears — the schedule may now run

    await ConnectedAccountModel.updateOne(
      { stripe_account_id: seller.stripeAccountId },
      { $set: { charges_enabled: false } },
    );
    await RtoInstallmentModel.updateOne(
      { agreement_id: agreementId, installment_number: 1 },
      { $set: { due_at: new Date(Date.now() - 60 * 86_400_000) } },
    );
    await rtoService.chargeDueInstallments();
    await rtoService.sweepDelinquency();

    expect(
      await RtoLedgerEntryModel.countDocuments({ agreement_id: agreementId, entry_type: 'late_fee' }),
    ).toBe(0);
  });
});

describe('Consignment Rent-to-Own — 3-party split + statements (R19/B4)', () => {
  it('splits a $100 installment across owner / managing business / platform and reconciles to gross', async () => {
    const seller = await approvedSeller('crto');
    const ownerBusinessId = await payoutEnabledBusiness('crto');
    const listingId = await publishListing(seller, HUNDRED_A_WEEK, {
      productName: 'Consigned Guitar',
      // §54 — the arrangement is settled at PUBLISH, between the owner and the managing business.
      isConsignment: true,
      ownerId: ownerBusinessId,
      ownerType: 'business',
      commissionBps: 3000, // managing business keeps 30% of the distributable
      consignmentTerms: CONSIGNMENT_TERMS,
    });
    const token = await customer('crto');

    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'crto-1')
      .send({ listingId });
    expect(accept.status).toBe(201);
    const agreementId = accept.body.data.id as string;
    await settlePendingPayment(agreementId); // the deposit clears — the schedule may now run

    // Charge installment #1 ($100 gross).
    await RtoInstallmentModel.updateOne(
      { agreement_id: agreementId, installment_number: 1 },
      { $set: { due_at: new Date(Date.now() - 60_000) } },
    );
    const swept = await rtoService.chargeDueInstallments();
    expect(swept.charged).toBeGreaterThanOrEqual(1);

    const st = await request(app).get(`/api/v1/rto/agreements/${agreementId}/statements`).set(...bearer(token));
    expect(st.status).toBe(200);
    // gross 10000 → platform 1000 (10%); distributable 9000 → commission 2700 (30%), owner 6300.
    expect(st.body.data.parties.platform.totalCents).toBe(1000);
    expect(st.body.data.parties.managing_business.totalCents).toBe(2700);
    expect(st.body.data.parties.owner.totalCents).toBe(6300);
    // B4: the split lines reconcile exactly to the gross collected.
    expect(st.body.data.reconciliation.clean).toBe(true);
    expect(st.body.data.reconciliation.splitTotalCents).toBe(10000);
    expect(st.body.data.reconciliation.grossCollectedCents).toBe(10000);
  });

  /**
   * §54 — a three-party deal must state all ten allocations up front. Refused rather than defaulted:
   * with two businesses and a customer there is no obvious answer to who eats a damaged item, and
   * guessing one just buries the disagreement until it costs somebody money.
   */
  it('§54: refuses a consignment RTO that does not state the three-party allocations', async () => {
    const seller = await approvedSeller('crto-noterms');
    const ownerBusinessId = await payoutEnabledBusiness('crto-noterms');
    const token = await customer('crto-noterms');
    // A consignment offer with no allocations is refused at PUBLISH — a customer never sees one.
    const res = await request(app)
      .post('/api/v1/rto/listings')
      .set(...bearer(seller.vendorToken))
      .send({
        sellerId: seller.businessId,
        productName: 'Consigned Amp',
        categoryId: seller.categoryId,
        citySlug: RTO_CITY,
        quantityAvailable: 1,
        ...TERMS,
        isConsignment: true,
        ownerId: ownerBusinessId,
        ownerType: 'business',
        commissionBps: 3000,
      });
    expect(res.status).toBe(400);
    void token;
  });

  it('§54: carries the ten allocations onto the agreement in plain language', async () => {
    const seller = await approvedSeller('crto-terms');
    const ownerBusinessId = await payoutEnabledBusiness('crto-terms');
    const listingId = await publishListing(seller, TERMS, {
      productName: 'Consigned Amp',
      isConsignment: true,
      ownerId: ownerBusinessId,
      ownerType: 'business',
      commissionBps: 3000,
      consignmentTerms: CONSIGNMENT_TERMS,
    });
    const token = await customer('crto-terms');

    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'crto-terms-1')
      .send({ listingId });
    expect(accept.status).toBe(201);

    const dash = await request(app)
      .get(`/api/v1/rto/agreements/${accept.body.data.id}`)
      .set(...bearer(token));
    const text = (dash.body.data.obligations as string[]).join(' ');
    expect(text).toMatch(/product owner holds ownership/i);
    expect(text).toMatch(/Returns are managed by the managing business/i);
    expect(text).toMatch(/Early payoff is approved by the product owner/i);
    expect(text).toMatch(/Ownership transfers to the customer at the final payment or early payoff/i);
    expect(text).toContain(CONSIGNMENT_TERMS.paymentDivisionNote);
  });
});

/**
 * §44 — the obligations a listing must disclose are STRUCTURED, not prose. They vary between
 * listings (two sellers can allocate maintenance differently), so they are fields snapshotted onto
 * the agreement: validatable, comparable, and readable for the life of the deal.
 */
/**
 * The gates that decide whether RTO may happen at all. Each was either absent or allow-by-default
 * before: the city flag was documented and never checked, the category rule allowed anything that
 * wasn't licence-regulated, and nothing stopped acceptance against placeholder legal text.
 */
describe('RTO compliance gates (§43/§60)', () => {
  it('§60: refuses acceptance while the agreement is still in legal review', async () => {
    const seller = await approvedSeller('rto-unreviewed');
    const listingId = await publishListing(seller);
    const token = await customer('rto-unreviewed');

    // Put the gate back exactly as production has it today.
    const restore = setAgreementReviewedForTest('rto', false);
    try {
      const res = await request(app)
        .post('/api/v1/rto/agreements')
        .set(...bearer(token))
        .set('Idempotency-Key', 'rto-unreviewed-1')
        .send({ listingId });
      expect(res.status).toBe(422);
      expect(res.body.error.message).toMatch(/legal review/i);
    } finally {
      restore();
    }
  });

  it('§43: refuses a category an admin has not opened for RTO', async () => {
    const seller = await approvedSeller('rto-closedcat');
    await CategoryModel.updateOne({ _id: seller.categoryId }, { $set: { rto_eligible: false } });

    const res = await request(app)
      .post('/api/v1/rto/listings')
      .set(...bearer(seller.vendorToken))
      .send({
        sellerId: seller.businessId,
        productName: 'Sofa',
        categoryId: seller.categoryId,
        citySlug: RTO_CITY,
        quantityAvailable: 1,
        ...TERMS,
      });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/not open for this category/i);
  });

  it('§43: a prohibited category can never be opened, even by an admin', async () => {
    const cat = await CategoryModel.create({
      slug: 'vehicles',
      name: 'Vehicles',
      top_level_tab: 'shopping',
      requires_license: false,
    });
    await seedUser({ authProviderId: 'rto-veh|admin', roles: ['admin'] });
    const adminToken = await mintToken('rto-veh|admin');

    const res = await request(app)
      .patch(`/api/v1/admin/categories/${String(cat._id)}`)
      .set(...bearer(adminToken))
      .send({ rtoEligible: true });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/never be opened/i);

    const after = await CategoryModel.findById(cat._id).lean();
    expect(after!.rto_eligible).toBe(false);
  });

  it('§60.3: refuses a city the platform has not cleared', async () => {
    const seller = await approvedSeller('rto-closedcity');
    const res = await request(app)
      .post('/api/v1/rto/listings')
      .set(...bearer(seller.vendorToken))
      .send({
        sellerId: seller.businessId,
        productName: 'Sofa',
        categoryId: seller.categoryId,
        citySlug: 'nowhere-town',
        quantityAvailable: 1,
        ...TERMS,
      });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/not available in this area/i);
  });
});

/**
 * §42 — terms belong to the SELLER. Before listings existed, `POST /rto/agreements` took the cash
 * price, markup and schedule from the customer's request body: a customer could author an agreement
 * for any product at any price and the seller was never consulted.
 */
describe('RTO listings are the source of every term (§42)', () => {
  it('prices the agreement from the listing, not from anything the customer sends', async () => {
    const seller = await approvedSeller('rto-terms-src');
    const listingId = await publishListing(seller); // $100 cash, 10% markup → $110 to own
    const token = await customer('rto-terms-src');

    // A customer naming their own price is rejected by the schema — there is no field to put it in.
    const res = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-terms-src-1')
      .send({ listingId, cashPriceCents: 1 });
    expect(res.status).toBe(400);

    const honest = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-terms-src-2')
      .send({ listingId });
    expect(honest.status).toBe(201);
    expect(honest.body.data.cashPriceCents).toBe(10000);
    expect(honest.body.data.totalToOwnCents).toBe(11000);
  });

  it('publishes a browsable offer with its full §44 disclosure, before anyone signs in', async () => {
    const seller = await approvedSeller('rto-browse');
    await publishListing(seller, TERMS, { productName: 'Browsable Bike' });

    // Public — deciding whether RTO is for you should not require an account.
    const browse = await request(app).get('/api/v1/rto/listings').query({ citySlug: RTO_CITY });
    expect(browse.status).toBe(200);
    const row = browse.body.data.find(
      (l: { productName: string }) => l.productName === 'Browsable Bike',
    );
    expect(row).toBeTruthy();

    const detail = await request(app).get(`/api/v1/rto/listings/${row.id as string}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.totalToOwnCents).toBe(11000);
    expect(detail.body.data.costOverCashCents).toBe(1000);
    // §47's sentence, on the offer itself.
    expect(detail.body.data.disclosure).toMatch(/may cost more than buying outright/i);
    expect(detail.body.data.obligations.length).toBeGreaterThan(0);
  });

  it('cannot be taken past its stock', async () => {
    const seller = await approvedSeller('rto-stock');
    const listingId = await publishListing(seller, TERMS, { quantityAvailable: 1 });

    const first = await customer('rto-stock-a');
    const taken = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(first))
      .set('Idempotency-Key', 'rto-stock-1')
      .send({ listingId });
    expect(taken.status).toBe(201);

    const second = await customer('rto-stock-b');
    const soldOut = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(second))
      .set('Idempotency-Key', 'rto-stock-2')
      .send({ listingId });
    expect(soldOut.status).toBe(422);
    expect(soldOut.body.error.message).toMatch(/just been taken/i);
  });

  it('refuses a listing paused by its seller', async () => {
    const seller = await approvedSeller('rto-paused');
    const listingId = await publishListing(seller);
    await request(app)
      .patch(`/api/v1/rto/listings/${listingId}`)
      .set(...bearer(seller.vendorToken))
      .send({ status: 'paused' })
      .expect(200);

    const token = await customer('rto-paused');
    const res = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-paused-1')
      .send({ listingId });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/no longer available/i);
  });

  it('will not let a seller rent from themselves', async () => {
    const seller = await approvedSeller('rto-self');
    const listingId = await publishListing(seller);
    const res = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(seller.vendorToken))
      .set('Idempotency-Key', 'rto-self-1')
      .send({ listingId });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/your own listing/i);
  });
});

describe('RTO listing obligations (§44)', () => {
  it('discloses maintenance, damage, return rights and cancellation before acceptance', async () => {
    await approvedSeller('rto-oblig');
    const token = await customer('rto-oblig');
    const res = await request(app)
      .post('/api/v1/rto/disclose')
      .set(...bearer(token))
      .send({
        ...TERMS,
        listingTerms: {
          maintenanceResponsibility: 'seller',
          damageResponsibility: 'customer',
          returnAllowed: true,
          returnTransportResponsibility: 'customer',
          restockingFeeCents: 1500,
          paymentsRefundableOnReturn: false,
          ownershipCreditPreservedOnReturn: false,
          cancellationNoticeDays: 14,
          deliveryFeeCents: 2500,
          taxBps: 875,
        },
      });
    expect(res.status).toBe(200);
    const text = (res.body.data.obligations as string[]).join(' ');
    expect(text).toMatch(/The seller is responsible for maintaining/i);
    expect(text).toMatch(/You are responsible for loss or damage/i);
    expect(text).toMatch(/\$15\.00 restocking fee/);
    expect(text).toMatch(/14 days' notice/);
    expect(text).toMatch(/\$25\.00 delivery fee/);
    expect(text).toMatch(/8\.75%/);
    // §51's sentence that must never be softened.
    expect(text).toMatch(/previous payments are NOT refunded/);
    expect(text).toMatch(/does not carry over/i);
  });

  /**
   * Silence must never imply a protection. A seller who says nothing gets the conservative reading —
   * no voluntary return offered, nothing refundable — rather than defaults that promise on their
   * behalf and would have to be honoured.
   */
  it('defaults to the conservative reading when a seller states nothing', async () => {
    await approvedSeller('rto-defaults');
    const token = await customer('rto-defaults');
    const res = await request(app)
      .post('/api/v1/rto/disclose')
      .set(...bearer(token))
      .send(TERMS);

    expect(res.body.data.listingTerms.returnAllowed).toBe(false);
    expect(res.body.data.listingTerms.paymentsRefundableOnReturn).toBe(false);
    expect(res.body.data.listingTerms.ownershipCreditPreservedOnReturn).toBe(false);
    const text = (res.body.data.obligations as string[]).join(' ');
    expect(text).toMatch(/does not offer a voluntary return/i);
  });

  it('snapshots the terms onto the agreement so they stay readable after acceptance', async () => {
    const seller = await approvedSeller('rto-snap');
    const listingId = await publishListing(seller, TERMS, {
      productName: 'Washer',
      listingTerms: {
        maintenanceResponsibility: 'seller',
        returnAllowed: true,
        paymentsRefundableOnReturn: true,
      },
    });
    const token = await customer('rto-snap');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-snap-1')
      .send({ listingId });
    expect(accept.status).toBe(201);

    const dash = await request(app)
      .get(`/api/v1/rto/agreements/${accept.body.data.id}`)
      .set(...bearer(token));
    const text = (dash.body.data.obligations as string[]).join(' ');
    // The customer four months in gets the answer THEIR agreement gave, not the current defaults.
    expect(text).toMatch(/The seller is responsible for maintaining/i);
    expect(text).toMatch(/previous payments are refundable/i);
  });
});

/**
 * §50 — the seller's alternatives to letting an agreement fail.
 *
 * None of these existed: the sweep could move an agreement Grace → Late and then stop, so
 * delinquency was the only outcome available to a customer in trouble, and four declared statuses
 * were unreachable (audit F-3). The spec closes §50 with "encourage communication before
 * cancellation"; these are what that means in code.
 */
describe('RTO seller remedies (§50)', () => {
  async function liveAgreement(prefix: string) {
    const seller = await approvedSeller(prefix);
    const listingId = await publishListing(seller);
    const token = await customer(prefix);
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', `${prefix}-1`)
      .send({ listingId });
    expect(accept.status).toBe(201);
    const agreementId = accept.body.data.id as string;
    // The deposit clears. Without it nothing is credited and the sweep will not bill at all, so
    // every test below would be exercising an agreement that never actually started.
    await settlePendingPayment(agreementId);
    return { seller, token, agreementId };
  }

  it('gives more time: pushes the due date and clears the late status', async () => {
    const { seller, agreementId } = await liveAgreement('rto-defer');
    await RtoAgreementModel.updateOne({ _id: agreementId }, { $set: { status: 'late' } });

    const res = await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/defer`)
      .set(...bearer(seller.vendorToken))
      .send({ days: 7 });
    expect(res.status).toBe(200);

    const row = await RtoAgreementModel.findById(agreementId).lean();
    // Not late against a date that has moved.
    expect(row!.status).toBe('active');
    expect(row!.deferrals_granted).toBe(1);
    expect(row!.next_due_at!.getTime()).toBeGreaterThan(Date.now());
  });

  it('accepts a part payment against arrears — which buys no ownership credit', async () => {
    const { seller, agreementId } = await liveAgreement('rto-partial');
    const before = await RtoAgreementModel.findById(agreementId).lean();

    const res = await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/partial-payment`)
      .set(...bearer(seller.vendorToken))
      .set('Idempotency-Key', 'rto-partial-pay-1')
      .send({ amountCents: 1500 });
    expect(res.status).toBe(200);

    const row = await RtoAgreementModel.findById(agreementId).lean();
    expect(row!.arrears_paid_cents).toBe(1500);
    /**
     * The load-bearing assertion: catching up on rent already owed is not equity in the goods.
     * Crediting it would quietly tell a struggling customer they own more of the item than they do.
     */
    expect(row!.ownership_credited_cents).toBe(before!.ownership_credited_cents);
    const ledger = await RtoLedgerEntryModel.findOne({
      agreement_id: agreementId,
      amount_cents: 1500,
    }).lean();
    expect(ledger!.ownership_credit_cents).toBe(0);
  });

  it('agrees a catch-up plan, reaching the arrangement status', async () => {
    const { seller, agreementId } = await liveAgreement('rto-arr');
    const dueAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const res = await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/arrangement`)
      .set(...bearer(seller.vendorToken))
      .send({ catchUpCents: 4000, dueAt, note: 'Two payments over a fortnight' });
    expect(res.status).toBe(200);

    const row = await RtoAgreementModel.findById(agreementId).lean();
    expect(row!.status).toBe('arrangement');
    expect(row!.arrangement!.catch_up_cents).toBe(4000);
  });

  it('pauses the clock: no charge is attempted while it holds, then reinstates', async () => {
    const { seller, agreementId } = await liveAgreement('rto-pause');
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
    await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/pause`)
      .set(...bearer(seller.vendorToken))
      .send({ until })
      .expect(200);
    expect((await RtoAgreementModel.findById(agreementId).lean())!.status).toBe('paused');

    // Make an instalment due; the sweep must skip a paused agreement entirely.
    await RtoInstallmentModel.updateOne(
      { agreement_id: agreementId, installment_number: 1 },
      { $set: { due_at: new Date(Date.now() - 60_000) } },
    );
    await rtoService.chargeDueInstallments();
    const inst = await RtoInstallmentModel.findOne({
      agreement_id: agreementId,
      installment_number: 1,
    }).lean();
    expect(inst!.status).toBe('scheduled');

    await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/reinstate`)
      .set(...bearer(seller.vendorToken))
      .expect(200);
    const back = await RtoAgreementModel.findById(agreementId).lean();
    expect(back!.status).toBe('active');
    expect(back!.pause_until).toBeNull();
  });

  it('is the SELLER’s to grant — a customer cannot pause their own agreement', async () => {
    const { token, agreementId } = await liveAgreement('rto-notmine');
    const res = await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/pause`)
      .set(...bearer(token))
      .send({ until: new Date(Date.now() + 86_400_000).toISOString() });
    // Forbearance a customer can grant themselves is an option to stop paying.
    expect([403, 422]).toContain(res.status);
  });
});

/**
 * §51 — voluntary return. The customer-protection half of rent-to-own, and the half that did not
 * exist: `return_pending` was declared and unreachable, so the only way out of an agreement was to
 * pay it off or default.
 */
describe('RTO voluntary return (§51)', () => {
  async function agreementWith(prefix: string, listingTerms: Record<string, unknown>) {
    const seller = await approvedSeller(prefix);
    const listingId = await publishListing(seller, TERMS, { listingTerms });
    const token = await customer(prefix);
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', `${prefix}-1`)
      .send({ listingId });
    expect(accept.status).toBe(201);
    const agreementId = accept.body.data.id as string;
    // The deposit clears. Without it nothing is credited and the sweep will not bill at all, so
    // every test below would be exercising an agreement that never actually started.
    await settlePendingPayment(agreementId);
    return { seller, token, agreementId };
  }

  it('refuses a customer return when the agreement never offered one', async () => {
    const { token, agreementId } = await agreementWith('rto-noret', { returnAllowed: false });

    const preview = await request(app)
      .get(`/api/v1/rto/agreements/${agreementId}/return-preview`)
      .set(...bearer(token));
    expect(preview.status).toBe(200);
    expect(preview.body.data.allowed).toBe(false);
    expect(preview.body.data.disclosure).toMatch(/does not offer a voluntary return/i);

    const res = await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/return`)
      .set(...bearer(token));
    expect(res.status).toBe(422);
  });

  /**
   * The §51 sentence that must never be softened: a customer is not told previous payments create
   * ownership unless the agreement actually grants credit.
   */
  it('states plainly that payments are not refunded when the terms do not refund them', async () => {
    const { token, agreementId } = await agreementWith('rto-ret-norefund', {
      returnAllowed: true,
      paymentsRefundableOnReturn: false,
      ownershipCreditPreservedOnReturn: false,
    });
    const preview = await request(app)
      .get(`/api/v1/rto/agreements/${agreementId}/return-preview`)
      .set(...bearer(token));
    expect(preview.body.data.allowed).toBe(true);
    expect(preview.body.data.refundCents).toBe(0);
    expect(preview.body.data.disclosure).toMatch(/NOT refunded/);
    expect(preview.body.data.disclosure).toMatch(/does not carry over/i);
  });

  it('refunds and preserves credit when the terms say so, net of the restocking fee', async () => {
    const { seller, token, agreementId } = await agreementWith('rto-ret-refund', {
      returnAllowed: true,
      paymentsRefundableOnReturn: true,
      ownershipCreditPreservedOnReturn: true,
      restockingFeeCents: 500,
    });

    // $20 initial payment was taken at acceptance; a $5 restocking fee comes out of the refund.
    const preview = await request(app)
      .get(`/api/v1/rto/agreements/${agreementId}/return-preview`)
      .set(...bearer(token));
    expect(preview.body.data.refundCents).toBe(1500);
    expect(preview.body.data.restockingFeeCents).toBe(500);
    expect(preview.body.data.creditPreservedCents).toBe(2000);

    // The customer asks; the seller records the goods coming back with a §52 return report.
    await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/return`)
      .set(...bearer(token))
      .expect(200);
    expect((await RtoAgreementModel.findById(agreementId).lean())!.status).toBe('return_pending');

    const done = await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/return/complete`)
      .set(...bearer(seller.vendorToken))
      .set('Idempotency-Key', 'rto-ret-complete-1')
      .send({
        photos: ['https://cdn.test/back-1.jpg'],
        videoUrl: 'https://cdn.test/back.mp4',
        existingDamage: 'Scuff on the lid',
        accessories: ['power cable'],
        estimatedValueCents: 55_000,
      });
    expect(done.status).toBe(200);

    const row = await RtoAgreementModel.findById(agreementId).lean();
    expect(row!.status).toBe('cancelled');
    expect(row!.cancelled_reason).toBe('returned');
    expect(row!.return_refund_cents).toBe(1500);
    // F-4: `condition_return` had no writer at all before this.
    expect(row!.condition_return.recorded_at).toBeTruthy();
    expect(row!.condition_return.existing_damage).toBe('Scuff on the lid');
    expect(row!.condition_return.video_url).toBe('https://cdn.test/back.mp4');
    // The refund is on the immutable ledger as an event, not netted off a total somewhere.
    const refund = await RtoLedgerEntryModel.findOne({
      agreement_id: agreementId,
      entry_type: 'refund',
    }).lean();
    expect(refund!.amount_cents).toBe(-1500);
    // Nothing further is owed on goods that have gone back.
    const remaining = await RtoInstallmentModel.find({
      agreement_id: agreementId,
      status: 'scheduled',
    }).lean();
    expect(remaining).toHaveLength(0);
  });

  it('never charges an agreement whose goods are on their way back', async () => {
    const { token, agreementId } = await agreementWith('rto-ret-nocharge', { returnAllowed: true });
    await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/return`)
      .set(...bearer(token))
      .expect(200);

    await RtoInstallmentModel.updateOne(
      { agreement_id: agreementId, installment_number: 1 },
      { $set: { due_at: new Date(Date.now() - 60_000) } },
    );
    await rtoService.chargeDueInstallments();
    const inst = await RtoInstallmentModel.findOne({
      agreement_id: agreementId,
      installment_number: 1,
    }).lean();
    // Billing someone for an item sitting in the van is the bug this guards.
    expect(inst!.status).toBe('scheduled');
  });
});

/**
 * §52 — condition documentation at delivery AND at return, both signed by both parties. A report
 * only one side signed is that side's account of the condition, not an agreed fact.
 */
describe('RTO condition reports (§52)', () => {
  it('captures every field the spec names and needs both signatures to be agreed', async () => {
    const seller = await approvedSeller('rto-cond');
    const listingId = await publishListing(seller);
    const token = await customer('rto-cond');

    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-cond-1')
      .send({
        listingId,
        condition: {
          photos: ['https://cdn.test/a.jpg'],
          videoUrl: 'https://cdn.test/walkround.mp4',
          serial: 'SN-12345',
          existingDamage: 'Small dent, front left',
          accessories: ['charger', 'manual'],
          estimatedValueCents: 60_000,
        },
      });
    expect(accept.status).toBe(201);
    const agreementId = accept.body.data.id as string;

    const dash = await request(app)
      .get(`/api/v1/rto/agreements/${agreementId}`)
      .set(...bearer(token));
    const report = dash.body.data.conditionDelivery;
    expect(report.videoUrl).toBe('https://cdn.test/walkround.mp4');
    expect(report.serial).toBe('SN-12345');
    expect(report.existingDamage).toBe('Small dent, front left');
    expect(report.accessories).toEqual(['charger', 'manual']);
    expect(report.estimatedValueCents).toBe(60_000);
    // The customer signed at acceptance; the seller has not, so it is not yet agreed.
    expect(report.customerAcknowledged).toBe(true);
    expect(report.sellerAcknowledged).toBe(false);
    expect(report.agreed).toBe(false);

    await request(app)
      .post(`/api/v1/rto/agreements/${agreementId}/condition/acknowledge`)
      .set(...bearer(seller.vendorToken))
      .send({ report: 'delivery' })
      .expect(200);

    const after = await request(app)
      .get(`/api/v1/rto/agreements/${agreementId}`)
      .set(...bearer(token));
    expect(after.body.data.conditionDelivery.agreed).toBe(true);
  });
});

/**
 * §49 — five reminder stages: before due, on due, during grace, when late, and before recovery.
 * Only the silent Grace → Late escalation existed, so the first thing a customer heard about a
 * missed payment was that they were already late.
 */
describe('RTO payment reminders (§49)', () => {
  it('fires each stage once, and re-arms when the due date moves', async () => {
    const seller = await approvedSeller('rto-remind');
    const listingId = await publishListing(seller);
    const token = await customer('rto-remind');
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', 'rto-remind-1')
      .send({ listingId });
    const agreementId = accept.body.data.id as string;

    const setDue = (offsetDays: number) =>
      RtoAgreementModel.updateOne(
        { _id: agreementId },
        { $set: { next_due_at: new Date(Date.now() + offsetDays * 86_400_000) } },
      );

    // 1. Before it's due.
    await setDue(2);
    expect((await rtoService.sweepReminders()).upcoming).toBeGreaterThanOrEqual(1);
    // Fires once per due date, not once per sweep.
    expect((await rtoService.sweepReminders()).upcoming).toBe(0);

    // 2. On the day.
    await setDue(0);
    expect((await rtoService.sweepReminders()).due_today).toBeGreaterThanOrEqual(1);

    // 3. Inside the grace period.
    await setDue(-2);
    expect((await rtoService.sweepReminders()).grace).toBeGreaterThanOrEqual(1);

    // 4. Late.
    await setDue(-10);
    expect((await rtoService.sweepReminders()).late).toBeGreaterThanOrEqual(1);

    // 5. The last message before the seller can ask for the item back.
    await setDue(-30);
    expect((await rtoService.sweepReminders()).pre_recovery).toBeGreaterThanOrEqual(1);

    /**
     * A moved due date is a new conversation: the customer should hear the "coming up" reminder for
     * the new date rather than nothing because they heard it for the old one.
     */
    await setDue(1);
    expect((await rtoService.sweepReminders()).upcoming).toBeGreaterThanOrEqual(1);
  });
});

/**
 * 6.3 — adversarial tests over the RTO money path. Written where the fixtures already are; the
 * order/refund/settlement attacks live in `moneyPathAttacks.test.ts`.
 *
 * The threat model is an authenticated participant, not an outsider: a customer with a valid
 * session probing whether an id in a URL is enough to reach someone else's agreement, or whether
 * the remedies §50 gives the SELLER can be granted to themselves.
 */
describe('RTO money-path attacks (6.3)', () => {
  async function agreementFor(prefix: string) {
    const seller = await approvedSeller(prefix);
    const listingId = await publishListing(seller, TERMS, { productName: 'Attack Sofa' });
    const token = await customer(prefix);
    const accept = await request(app)
      .post('/api/v1/rto/agreements')
      .set(...bearer(token))
      .set('Idempotency-Key', `${prefix}-accept`)
      .send({ listingId });
    return { seller, token, agreementId: accept.body.data.id as string };
  }

  it("a customer cannot pay off someone else's agreement", async () => {
    // Payoff moves money and transfers ownership. If the agreement id is enough, anyone who sees
    // one can buy a stranger's washing machine onto their own card — or, far more likely, be
    // charged for a stranger's.
    const victim = await agreementFor('atk-rto-payoff');
    const intruderToken = await customer('atk-rto-payoff-intruder');

    const res = await request(app)
      .post(`/api/v1/rto/agreements/${victim.agreementId}/payoff`)
      .set(...bearer(intruderToken))
      .set('Idempotency-Key', 'atk-rto-payoff-x')
      .send({});
    expect([403, 404]).toContain(res.status);
  });

  it("a customer cannot read someone else's agreement or statements", async () => {
    const victim = await agreementFor('atk-rto-read');
    const intruderToken = await customer('atk-rto-read-intruder');

    for (const path of ['', '/statements', '/ledger']) {
      const res = await request(app)
        .get(`/api/v1/rto/agreements/${victim.agreementId}${path}`)
        .set(...bearer(intruderToken));
      expect([403, 404], `GET ${path || '(root)'}`).toContain(res.status);
    }
  });

  it('a customer cannot grant themselves the §50 remedies that belong to the seller', async () => {
    // A customer who could pause their own agreement or move their own due date would not be
    // receiving forbearance — they would have an option to stop paying.
    const victim = await agreementFor('atk-rto-remedy');

    for (const [path, body] of [
      ['pause', { days: 30 }],
      ['defer', { days: 14 }],
    ] as const) {
      const res = await request(app)
        .post(`/api/v1/rto/agreements/${victim.agreementId}/${path}`)
        .set(...bearer(victim.token))
        .send(body);
      expect([400, 403, 404, 422], path).toContain(res.status);
    }
  });

  it('an unauthenticated caller cannot touch an agreement at all', async () => {
    const victim = await agreementFor('atk-rto-anon');
    const res = await request(app)
      .post(`/api/v1/rto/agreements/${victim.agreementId}/payoff`)
      .set('Idempotency-Key', 'atk-rto-anon-x')
      .send({});
    expect(res.status).toBe(401);
  });
});

/**
 * The pre-flight the offer form asks on load.
 *
 * It exists because all three gates used to fire only on SUBMIT: a vendor entered a cash price,
 * term, frequency, markup, quantity and both toggles, pressed Publish, and only then learned the
 * business had never been cleared for Rent-to-Own. The rules are right; their position was wrong.
 *
 * The property that matters most here is that this check and the publish path cannot drift — they
 * share the same predicates, so a vendor is never told "yes" by one and "no" by the other.
 */
describe('RTO eligibility pre-flight', () => {
  it('reports an unapproved business as blocked, with a reason it can act on', async () => {
    const cat = await CategoryModel.create({
      slug: 'rto-elig-unapproved-cat',
      name: 'elig',
      top_level_tab: 'shopping',
      requires_license: false,
      rto_eligible: true,
    });
    await seedUser({ authProviderId: 'rto-elig-unapproved|vendor', roles: ['vendor'] });
    const token = await mintToken('rto-elig-unapproved|vendor');
    const biz = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(token))
      .send({ name: 'Unapproved Store', categoryId: String(cat._id) });

    const res = await request(app)
      .get('/api/v1/rto/eligibility')
      .query({ sellerId: biz.body.data.id, citySlug: RTO_CITY })
      .set(...bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.data.eligible).toBe(false);
    expect(res.body.data.checks.sellerApproved).toBe(false);
    // A blocker the vendor cannot act on is just a dead end; it must say what to do next.
    expect(res.body.data.blockers[0].code).toBe('seller_not_approved');
    /**
     * Asserted as "names a real next step" rather than exact prose: the wording will change, but
     * copy that leaves someone stuck must not come back. There is no in-app request flow yet, so
     * that step is currently an email address.
     */
    expect(res.body.data.blockers[0].message).toMatch(/@|contact|email/i);
  });

  it('reports an approved business in a live city as eligible', async () => {
    const seller = await approvedSeller('rto-elig-ok');

    const res = await request(app)
      .get('/api/v1/rto/eligibility')
      .query({ sellerId: seller.businessId, citySlug: RTO_CITY, categoryId: seller.categoryId })
      .set(...bearer(seller.vendorToken));

    expect(res.body.data.eligible).toBe(true);
    expect(res.body.data.blockers).toHaveLength(0);
  });

  it('reports EVERY failing gate, not just the first', async () => {
    // Fixing one blocker only to meet the next is the same frustration served twice.
    const cat = await CategoryModel.create({
      slug: 'rto-elig-multi-cat',
      name: 'multi',
      top_level_tab: 'shopping',
      requires_license: false,
      rto_eligible: false, // category closed too
    });
    await seedUser({ authProviderId: 'rto-elig-multi|vendor', roles: ['vendor'] });
    const token = await mintToken('rto-elig-multi|vendor');
    const biz = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(token))
      .send({ name: 'Multi Store', categoryId: String(cat._id) });

    const res = await request(app)
      .get('/api/v1/rto/eligibility')
      .query({ sellerId: biz.body.data.id, citySlug: 'a-city-nobody-cleared', categoryId: String(cat._id) })
      .set(...bearer(token));

    const codes = (res.body.data.blockers as { code: string }[]).map((b) => b.code);
    expect(codes).toContain('seller_not_approved');
    expect(codes).toContain('city_not_enabled');
    expect(codes).toContain('category_not_eligible');
  });

  it('agrees with what publish actually does — the two cannot drift', async () => {
    // The whole point of sharing predicates. If this ever fails, one copy of a compliance rule has
    // stopped matching the other, and a vendor is being told "yes" then "no".
    const seller = await approvedSeller('rto-elig-agree');
    await CategoryModel.updateOne({ _id: seller.categoryId }, { $set: { rto_eligible: false } });

    const pre = await request(app)
      .get('/api/v1/rto/eligibility')
      .query({ sellerId: seller.businessId, citySlug: RTO_CITY, categoryId: seller.categoryId })
      .set(...bearer(seller.vendorToken));

    const publish = await request(app)
      .post('/api/v1/rto/listings')
      .set(...bearer(seller.vendorToken))
      .send({
        sellerId: seller.businessId,
        productName: 'Sofa',
        categoryId: seller.categoryId,
        citySlug: RTO_CITY,
        quantityAvailable: 1,
        ...TERMS,
      });

    expect(pre.body.data.eligible).toBe(false);
    expect(publish.status).toBeGreaterThanOrEqual(400);
  });

  it('will not let one business inspect another', async () => {
    const mine = await approvedSeller('rto-elig-mine');
    await seedUser({ authProviderId: 'rto-elig-other|vendor', roles: ['vendor'] });
    const otherToken = await mintToken('rto-elig-other|vendor');

    const res = await request(app)
      .get('/api/v1/rto/eligibility')
      .query({ sellerId: mine.businessId, citySlug: RTO_CITY })
      .set(...bearer(otherToken));

    expect(res.status).toBe(403);
  });
});
