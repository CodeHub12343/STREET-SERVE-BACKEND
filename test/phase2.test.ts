import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel, TransactionModel } from '../src/modules/payments/payments.model';
import { LiveSessionModel } from '../src/modules/livemap/livemap.model';
import { livemapService } from '../src/modules/livemap/livemap.service';
import { WaveDownModel, QueueEntryModel } from '../src/modules/queue/queue.model';
import { queueService } from '../src/modules/queue/queue.service';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase 2 exit criterion: "a vendor goes live, a customer sees the pin, waves down, joins the
 * queue at the correct server-timestamped tier, and pays with the locked discount." Plus go-live
 * license gating, nearby discovery, follow/notify, reviews, and the sweep jobs.
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();

beforeAll(() => {
  setStripeGateway(fakeStripe);
});

function stripeEvent(type: string, object: Record<string, unknown>) {
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', 'test')
    .set('content-type', 'application/json')
    .send(JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } }));
}

async function openCategory(slug: string): Promise<string> {
  const c = await CategoryModel.create({
    slug,
    name: slug,
    top_level_tab: 'services',
    requires_license: false,
  });
  return String(c._id);
}

/** Create a vendor + business + enabled Stripe connected account, ready to be charged. */
async function vendorWithLiveBusiness(
  prefix: string,
  categoryId: string,
  lng: number,
  lat: number,
) {
  await seedUser({ authProviderId: `${prefix}|vendor`, roles: ['vendor'] });
  const token = await mintToken(`${prefix}|vendor`);
  const created = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(token))
    .send({ name: `${prefix} Biz`, categoryId });
  const businessId = created.body.data.id as string;

  await request(app)
    .post(`/api/v1/businesses/${businessId}/payouts/onboard`)
    .set(...bearer(token));
  const acct = await ConnectedAccountModel.findOne({
    owner_type: 'business',
    owner_id: businessId,
  }).lean();
  fakeStripe.enableAccount(acct!.stripe_account_id);
  await stripeEvent('account.updated', { id: acct!.stripe_account_id });

  // R28: a vendor must accept the Terms of Sale once before going live.
  await request(app).post('/api/v1/agreements/regular_sale/accept').set(...bearer(token)).send({});

  const session = await request(app)
    .post('/api/v1/live-sessions/start')
    .set(...bearer(token))
    .send({ actorType: 'business', actorId: businessId, lng, lat, status: 'parked' });
  return { token, businessId, sessionId: session.body.data.id as string };
}

describe('go-live license gating', () => {
  it('blocks going live for a regulated category until a license is approved', async () => {
    const regulated = await CategoryModel.create({
      slug: 'p2-regulated',
      name: 'Regulated',
      top_level_tab: 'food',
      requires_license: true,
    });
    await seedUser({ authProviderId: 'p2|vendor-gate', roles: ['vendor'] });
    const token = await mintToken('p2|vendor-gate');
    const biz = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(token))
      .send({ name: 'Gated Truck', categoryId: String(regulated._id) });
    const businessId = biz.body.data.id as string;

    const blocked = await request(app)
      .post('/api/v1/live-sessions/start')
      .set(...bearer(token))
      .send({ actorType: 'business', actorId: businessId, lng: -121, lat: 37.6, status: 'parked' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('LICENSE_REQUIRED');

    const doc = await request(app)
      .post(`/api/v1/businesses/${businessId}/license-documents`)
      .set(...bearer(token))
      .send({ categoryId: String(regulated._id), documentUrl: 'https://d.test/p.pdf' });
    await seedUser({ authProviderId: 'p2|admin-gate', roles: ['admin'] });
    const adminToken = await mintToken('p2|admin-gate');
    await request(app)
      .post(`/api/v1/admin/license-documents/${doc.body.data.id}/review`)
      .set(...bearer(adminToken))
      .send({ approve: true });

    // License is now approved; accept the Terms of Sale so go-live is unblocked (R28).
    await request(app).post('/api/v1/agreements/regular_sale/accept').set(...bearer(token)).send({});

    const allowed = await request(app)
      .post('/api/v1/live-sessions/start')
      .set(...bearer(token))
      .send({ actorType: 'business', actorId: businessId, lng: -121, lat: 37.6, status: 'parked' });
    expect(allowed.status).toBe(201);
    expect(allowed.body.data.status).toBe('parked');
  });

  /**
   * R1 (discount-optional): a line-up discount is a growth lever, never a gate. A vendor with zero
   * discounts must be able to go live AND transact. This locks the invariant so a future "require a
   * discount to go live" regression is caught here rather than in the field.
   */
  it('lets a vendor with NO discount schedule go live and transact (R1)', async () => {
    const categoryId = await openCategory('p2-r1-nodiscount');
    const { businessId } = await vendorWithLiveBusiness('p2r1', categoryId, -121.3, 37.9);

    // No discount-schedule was ever set. The public queue state carries no tiers.
    const state = await request(app).get(`/api/v1/queues/business/${businessId}`);
    expect(state.status).toBe(200);
    expect(state.body.data.schedule?.tiers ?? []).toHaveLength(0);

    // A customer can still join and pay — at full price (0% locked), proving "transact" needs no discount.
    await seedUser({ authProviderId: 'p2r1|c1', roles: ['customer'] });
    const c1 = await mintToken('p2r1|c1');
    const join = await request(app)
      .post(`/api/v1/queues/business/${businessId}/join`)
      .set(...bearer(c1));
    expect(join.status).toBe(201);
    expect(join.body.data.discountPercent).toBe(0);

    const checkout = await request(app)
      .post(`/api/v1/queues/business/${businessId}/checkout`)
      .set(...bearer(c1))
      .set('Idempotency-Key', 'p2r1-checkout-1')
      .send({ baseAmountCents: 1000 });
    expect(checkout.status).toBe(201);
    expect(checkout.body.data.discountPercent).toBe(0);
    expect(checkout.body.data.chargeAmountCents).toBe(1000);
  });
});

describe('nearby discovery', () => {
  it('returns a live business pin within radius and honors filters', async () => {
    const categoryId = await openCategory('p2-nearby');
    const { businessId } = await vendorWithLiveBusiness('p2near', categoryId, -121.0, 37.6);

    const near = await request(app)
      .get('/api/v1/map/nearby')
      .query({ lat: 37.6, lng: -121.0, radiusM: 3000 });
    expect(near.status).toBe(200);
    expect(near.body.data.some((p: { actorId: string }) => p.actorId === businessId)).toBe(true);

    // Category filter by slug excludes non-matching.
    const filtered = await request(app)
      .get('/api/v1/map/nearby')
      .query({ lat: 37.6, lng: -121.0, radiusM: 3000, category: 'p2-nearby' });
    expect(filtered.body.data.some((p: { actorId: string }) => p.actorId === businessId)).toBe(
      true,
    );

    const far = await request(app)
      .get('/api/v1/map/nearby')
      .query({ lat: 40.0, lng: -121.0, radiusM: 3000 });
    expect(far.body.data.some((p: { actorId: string }) => p.actorId === businessId)).toBe(false);
  });

  it('serves each pin its resolved modules, so a result row can offer what the business does', async () => {
    const categoryId = await openCategory('p2-nearby-modules'); // 'services' tab → on_demand_service
    const { businessId } = await vendorWithLiveBusiness('p2mods', categoryId, -121.0, 37.6);

    const near = await request(app)
      .get('/api/v1/map/nearby')
      .query({ lat: 37.6, lng: -121.0, radiusM: 3000 });

    const pin = near.body.data.find((p: { actorId: string }) => p.actorId === businessId);
    // An on-demand trade leads with booking (every service now does, so the same tab behaves the
    // same way), and has no menu to order from.
    expect(pin.modules).toEqual(expect.arrayContaining(['services', 'booking', 'profile']));
    expect(pin.modules).not.toContain('menu');
  });

  it('the public profile carries the live status, so a customer knows if it is open for orders', async () => {
    const categoryId = await openCategory('p2-livestatus');
    const { businessId } = await vendorWithLiveBusiness('p2ls', categoryId, -121.2, 37.7);
    const live = await request(app).get(`/api/v1/businesses/${businessId}`);
    expect(live.status).toBe(200);
    expect(live.body.data.liveStatus).toBe('parked'); // open for pickup orders

    // A business with no active session is offline → liveStatus null (the order screen blocks it).
    await seedUser({ authProviderId: 'p2ls|v2', roles: ['vendor'] });
    const token2 = await mintToken('p2ls|v2');
    const created = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(token2))
      .send({ name: 'Offline Shop', categoryId });
    const offline = await request(app).get(`/api/v1/businesses/${created.body.data.id}`);
    expect(offline.body.data.liveStatus).toBeNull();
  });
});

describe('wave-down → queue → locked discount (Phase 2 exit)', () => {
  it('assigns server-timestamped positions, locks the discount at join, and charges the locked price', async () => {
    const categoryId = await openCategory('p2-queue');
    const { token: vendorToken, businessId } = await vendorWithLiveBusiness(
      'p2q',
      categoryId,
      -121.1,
      37.7,
    );

    // Vendor configures the line-up discount: 1st = 5%, 2nd = 10%, cap 15%.
    await request(app)
      .put(`/api/v1/queues/business/${businessId}/discount-schedule`)
      .set(...bearer(vendorToken))
      .send({
        tiers: [
          { position: 1, discount_percent: 5 },
          { position: 2, discount_percent: 10 },
        ],
        capPercent: 15,
      });

    await seedUser({ authProviderId: 'p2q|c1', roles: ['customer'] });
    await seedUser({ authProviderId: 'p2q|c2', roles: ['customer'] });
    const c1 = await mintToken('p2q|c1');
    const c2 = await mintToken('p2q|c2');

    // Customer 1 waves down; vendor accepts → auto-joined at position 1 with 5% locked.
    const wave = await request(app)
      .post('/api/v1/wave-downs')
      .set(...bearer(c1))
      .send({ targetType: 'business', targetId: businessId });
    const accept = await request(app)
      .post(`/api/v1/wave-downs/${wave.body.data.id}/accept`)
      .set(...bearer(vendorToken))
      .send({ etaSeconds: 120 });
    expect(accept.status).toBe(200);
    expect(accept.body.data.queue.position).toBe(1);
    expect(accept.body.data.queue.discountPercent).toBe(5);

    // Customer 2 joins directly → position 2 with 10% locked. Join returns the full membership the
    // customer's screen renders (business name, ahead count, status), not just the entry facts.
    const join2 = await request(app)
      .post(`/api/v1/queues/business/${businessId}/join`)
      .set(...bearer(c2));
    expect(join2.body.data.position).toBe(2);
    expect(join2.body.data.discountPercent).toBe(10);
    expect(join2.body.data.aheadCount).toBe(1);
    expect(join2.body.data.status).toBe('in_line');
    expect(join2.body.data.businessName).toEqual(expect.any(String));

    // GET /me reflects the same membership (the screen re-reads it on load/reconnect).
    const me = await request(app)
      .get(`/api/v1/queues/business/${businessId}/me`)
      .set(...bearer(c2));
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ position: 2, discountPercent: 10, status: 'in_line' });

    // A customer not in the line gets null, not a 404 (the screen treats null as "join me").
    await seedUser({ authProviderId: 'p2q|c3', roles: ['customer'] });
    const c3 = await mintToken('p2q|c3');
    const notIn = await request(app)
      .get(`/api/v1/queues/business/${businessId}/me`)
      .set(...bearer(c3));
    expect(notIn.status).toBe(200);
    expect(notIn.body.data).toBeNull();

    // Customer 1 pays with the locked 5% discount: base 1000 → 50 off → charge 950.
    const checkout = await request(app)
      .post(`/api/v1/queues/business/${businessId}/checkout`)
      .set(...bearer(c1))
      .set('Idempotency-Key', 'p2q-checkout-1')
      .send({ baseAmountCents: 1000 });
    expect(checkout.status).toBe(201);
    expect(checkout.body.data.discountPercent).toBe(5);
    expect(checkout.body.data.discountAppliedCents).toBe(50);
    expect(checkout.body.data.chargeAmountCents).toBe(950);
    expect(fakeStripe.lastCharge()?.amountCents).toBe(950);

    // R7: a wave/queue sale records the marketplace fee-type + 10% of the goods (950 → 95), proving
    // the 10% applies beyond the consignment path.
    const waveTxn = await TransactionModel.findById(checkout.body.data.transactionId).lean();
    expect(waveTxn?.fee_type).toBe('marketplace');
    expect(waveTxn?.platform_fee_cents).toBe(95);

    // Discount lock survives reflow: c1 leaving does not change c2's locked 10%.
    const state = await request(app).get(`/api/v1/queues/business/${businessId}`);
    const c2Entry = state.body.data.entries[0]; // c1 was served → left, so c2 is now first
    expect(c2Entry.position).toBe(1);
    expect(c2Entry.discountPercent).toBe(10);
  });

  /**
   * §32.4 travel fee. The vendor drove to the customer, so the fee they set is collected on the
   * checkout that follows — and disclosed at request time, before the customer commits. Previously
   * `travel_fee_cents` was an editable business setting that no money path ever read: a vendor set
   * a travel fee, saw it persist, and was never paid a cent of it.
   */
  it('§32.4: discloses the vendor travel fee on request and charges it once at checkout', async () => {
    const categoryId = await openCategory('p2-travel');
    const { token: vendorToken, businessId } = await vendorWithLiveBusiness(
      'p2tf',
      categoryId,
      -121.5,
      37.5,
    );
    // The vendor charges $5 to come to you.
    await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set(...bearer(vendorToken))
      .send({ travelFeeCents: 500 });

    await seedUser({ authProviderId: 'p2tf|cust', roles: ['customer'] });
    const cust = await mintToken('p2tf|cust');

    // Disclosed at request time — the customer sees the charge before they commit.
    const wave = await request(app)
      .post('/api/v1/wave-downs')
      .set(...bearer(cust))
      .send({ targetType: 'business', targetId: businessId });
    expect(wave.status).toBe(201);
    expect(wave.body.data.travelFeeCents).toBe(500);
    expect(wave.body.data.travelFeeDisclosure).toMatch(/\$5\.00/);

    await request(app)
      .post(`/api/v1/wave-downs/${wave.body.data.id}/accept`)
      .set(...bearer(vendorToken))
      .send({ etaSeconds: 300 });

    // Charged on the checkout that follows: 1000 goods + 500 travel = 1500.
    const checkout = await request(app)
      .post(`/api/v1/queues/business/${businessId}/checkout`)
      .set(...bearer(cust))
      .set('Idempotency-Key', 'p2tf-checkout-1')
      .send({ baseAmountCents: 1000 });
    expect(checkout.status).toBe(201);
    expect(checkout.body.data.travelFeeCents).toBe(500);
    expect(checkout.body.data.chargeAmountCents).toBe(1500);
    expect(fakeStripe.lastCharge()?.amountCents).toBe(1500);

    // The trip is billed ONCE. A second checkout against the same accepted wave collects goods only.
    const again = await request(app)
      .post(`/api/v1/queues/business/${businessId}/checkout`)
      .set(...bearer(cust))
      .set('Idempotency-Key', 'p2tf-checkout-2')
      .send({ baseAmountCents: 1000 });
    expect(again.status).toBe(201);
    expect(again.body.data.travelFeeCents).toBe(0);
    expect(again.body.data.chargeAmountCents).toBe(1000);
  });

  /**
   * §32.4 also allows the PLATFORM a convenience fee on a Waved Down request, separate from the
   * vendor's travel fee and paid by the customer for the dispatch itself. Both must be disclosed
   * before the customer confirms — "$5.99 of fees" tells them nothing about who they are paying.
   */
  it('§32.4: discloses and charges the platform convenience fee alongside the vendor travel fee', async () => {
    const { feeService } = await import('../src/modules/payments/fees');
    /**
     * Off at launch like every other customer-facing fee (§33), so the test turns it on explicitly —
     * and restores it, so a neighbouring test never sees a fee it did not ask for.
     */
    feeService.setOrderFeeFlags({ waveConvenience: true });
    const categoryId = await openCategory('p2-conv');
    const { token: vendorToken, businessId } = await vendorWithLiveBusiness(
      'p2cv',
      categoryId,
      -121.4,
      37.3,
    );
    await request(app)
      .patch(`/api/v1/businesses/${businessId}`)
      .set(...bearer(vendorToken))
      .send({ travelFeeCents: 500 });

    await seedUser({ authProviderId: 'p2cv|cust', roles: ['customer'] });
    const cust = await mintToken('p2cv|cust');

    const wave = await request(app)
      .post('/api/v1/wave-downs')
      .set(...bearer(cust))
      .send({ targetType: 'business', targetId: businessId });
    const convenience = await feeService.resolveFee('wave_convenience', 0);
    expect(convenience).toBeGreaterThan(0);

    // Both fees named separately, with their payees distinguishable.
    expect(wave.body.data.travelFeeCents).toBe(500);
    expect(wave.body.data.convenienceFeeCents).toBe(convenience);
    expect(wave.body.data.totalFeeCents).toBe(500 + convenience);
    expect(wave.body.data.feeLines).toEqual([
      { label: 'Vendor travel fee', amountCents: 500 },
      { label: 'Request fee', amountCents: convenience },
    ]);
    expect(wave.body.data.travelFeeDisclosure).toMatch(/come to you/);
    expect(wave.body.data.travelFeeDisclosure).toMatch(/request fee/i);

    await request(app)
      .post(`/api/v1/wave-downs/${wave.body.data.id as string}/accept`)
      .set(...bearer(vendorToken))
      .send({ etaSeconds: 300 });

    const checkout = await request(app)
      .post(`/api/v1/queues/business/${businessId}/checkout`)
      .set(...bearer(cust))
      .set('Idempotency-Key', 'p2cv-checkout-1')
      .send({ baseAmountCents: 1000 });
    expect(checkout.status).toBe(201);
    expect(checkout.body.data.convenienceFeeCents).toBe(convenience);
    expect(checkout.body.data.chargeAmountCents).toBe(1000 + 500 + convenience);

    /**
     * The convenience fee is the PLATFORM's, so it must not sit in the vendor's marketplace-fee
     * base — charging the 10% on top of our own fee would be a fee on a fee. The travel fee IS the
     * vendor's revenue and stays in.
     */
    const txn = await TransactionModel.findById(checkout.body.data.transactionId).lean();
    expect(txn?.service_fee_cents).toBe(convenience);
    expect(txn?.platform_fee_cents).toBe(150); // 10% of (1000 + 500), not of the convenience fee

    feeService.setOrderFeeFlags({ waveConvenience: false });
  });

  it('§32.4: charges no convenience fee while the launch flag is off', async () => {
    const categoryId = await openCategory('p2-conv-off');
    const { token: vendorToken, businessId } = await vendorWithLiveBusiness(
      'p2cvo',
      categoryId,
      -121.45,
      37.35,
    );
    await seedUser({ authProviderId: 'p2cvo|cust', roles: ['customer'] });
    const cust = await mintToken('p2cvo|cust');
    const wave = await request(app)
      .post('/api/v1/wave-downs')
      .set(...bearer(cust))
      .send({ targetType: 'business', targetId: businessId });
    expect(wave.body.data.convenienceFeeCents).toBe(0);
    expect(wave.body.data.travelFeeDisclosure).toBeNull();

    await request(app)
      .post(`/api/v1/wave-downs/${wave.body.data.id as string}/accept`)
      .set(...bearer(vendorToken))
      .send({ etaSeconds: 300 });
    const checkout = await request(app)
      .post(`/api/v1/queues/business/${businessId}/checkout`)
      .set(...bearer(cust))
      .set('Idempotency-Key', 'p2cvo-1')
      .send({ baseAmountCents: 1000 });
    expect(checkout.body.data.chargeAmountCents).toBe(1000);
  });

  it('§32.4: charges no travel fee when the vendor has not set one', async () => {
    const categoryId = await openCategory('p2-notravel');
    const { token: vendorToken, businessId } = await vendorWithLiveBusiness(
      'p2nt',
      categoryId,
      -121.6,
      37.4,
    );
    await seedUser({ authProviderId: 'p2nt|cust', roles: ['customer'] });
    const cust = await mintToken('p2nt|cust');

    const wave = await request(app)
      .post('/api/v1/wave-downs')
      .set(...bearer(cust))
      .send({ targetType: 'business', targetId: businessId });
    expect(wave.body.data.travelFeeCents).toBe(0);
    expect(wave.body.data.travelFeeDisclosure).toBeNull();

    await request(app)
      .post(`/api/v1/wave-downs/${wave.body.data.id}/accept`)
      .set(...bearer(vendorToken))
      .send({ etaSeconds: 300 });

    const checkout = await request(app)
      .post(`/api/v1/queues/business/${businessId}/checkout`)
      .set(...bearer(cust))
      .set('Idempotency-Key', 'p2nt-checkout-1')
      .send({ baseAmountCents: 1000 });
    expect(checkout.body.data.travelFeeCents).toBe(0);
    expect(checkout.body.data.chargeAmountCents).toBe(1000);
  });

  /**
   * The vendor's wave inbox (V-03). The UI shipped against GET /businesses/:id/wave-downs but the
   * endpoint didn't exist, so the inbox always read empty and a wave could never be accepted.
   */
  it('lists a pending incoming wave for the owner, then drops it once accepted', async () => {
    const categoryId = await openCategory('p2-inbox');
    const { token: vendorToken, businessId } = await vendorWithLiveBusiness('p2i', categoryId, -121.3, 37.9);
    await seedUser({ authProviderId: 'p2i|cust', roles: ['customer'], displayName: 'Ada Lovelace' });
    const cust = await mintToken('p2i|cust');

    const wave = await request(app)
      .post('/api/v1/wave-downs')
      .set(...bearer(cust))
      .send({ targetType: 'business', targetId: businessId, note: 'corner of 5th' });

    const inbox = await request(app)
      .get(`/api/v1/businesses/${businessId}/wave-downs`)
      .set(...bearer(vendorToken));
    expect(inbox.status).toBe(200);
    expect(inbox.body.data).toHaveLength(1);
    expect(inbox.body.data[0]).toMatchObject({
      id: wave.body.data.id,
      customerName: 'Ada Lovelace',
      note: 'corner of 5th',
    });
    // slaDeadline is a usable ISO timestamp, not undefined (the countdown depends on it).
    expect(new Date(inbox.body.data[0].slaDeadline).getTime()).toBeGreaterThan(Date.now());

    // A non-owner cannot read another business's inbox.
    await seedUser({ authProviderId: 'p2i|other', roles: ['vendor'] });
    const other = await mintToken('p2i|other');
    const forbidden = await request(app)
      .get(`/api/v1/businesses/${businessId}/wave-downs`)
      .set(...bearer(other));
    expect(forbidden.status).toBe(403);

    // Once accepted, it leaves the pending inbox.
    await request(app)
      .post(`/api/v1/wave-downs/${wave.body.data.id}/accept`)
      .set(...bearer(vendorToken))
      .send({ etaSeconds: 120 })
      .expect(200);
    const after = await request(app)
      .get(`/api/v1/businesses/${businessId}/wave-downs`)
      .set(...bearer(vendorToken));
    expect(after.body.data).toHaveLength(0);

    // And the CUSTOMER's tracker — which polls GET /wave-downs/:id — now reflects the acceptance
    // (previously it read a static cache and sat on "waiting" forever). It also carries the target
    // name so the screen renders on a cold load.
    const tracker = await request(app)
      .get(`/api/v1/wave-downs/${wave.body.data.id}`)
      .set(...bearer(cust));
    expect(tracker.status).toBe(200);
    expect(tracker.body.data.status).toBe('accepted');
    expect(tracker.body.data.etaSeconds).toBe(120);
    expect(tracker.body.data.targetName).toBe('p2i Biz'); // vendorWithLiveBusiness names it `${prefix} Biz`

    // The CUSTOMER's own wave-down history (C-25) lists it with the target's name — there was no
    // such endpoint, so the Orders tab's Wave-downs filter was always empty.
    const mine = await request(app).get('/api/v1/wave-downs/mine').set(...bearer(cust));
    expect(mine.status).toBe(200);
    const row = mine.body.data.find((w: { id: string }) => w.id === wave.body.data.id);
    expect(row).toMatchObject({ businessName: 'p2i Biz', status: 'accepted', note: 'corner of 5th' });
  });

  /**
   * The vendor queue-management screen (V-04) showed only a count and an un-settable, empty discount
   * ladder. This owner-gated view now carries the line WITH names, the tiers, and the live session id
   * for Pop-Up — none of which the public queue read exposes (names are private).
   */
  it('gives the owner a manage view: the line with names, the tiers, and the live session id', async () => {
    const categoryId = await openCategory('p2-manage');
    const { token, businessId, sessionId } = await vendorWithLiveBusiness('p2m', categoryId, -121.5, 38.1);
    await request(app)
      .put(`/api/v1/queues/business/${businessId}/discount-schedule`)
      .set(...bearer(token))
      .send({ tiers: [{ position: 1, discount_percent: 5 }, { position: 2, discount_percent: 10 }], capPercent: 15 });

    await seedUser({ authProviderId: 'p2m|c1', roles: ['customer'], displayName: 'Ada Lovelace' });
    await seedUser({ authProviderId: 'p2m|c2', roles: ['customer'], displayName: 'Grace Hopper' });
    const c1 = await mintToken('p2m|c1');
    const c2 = await mintToken('p2m|c2');
    await request(app).post(`/api/v1/queues/business/${businessId}/join`).set(...bearer(c1));
    await request(app).post(`/api/v1/queues/business/${businessId}/join`).set(...bearer(c2));

    const view = await request(app).get(`/api/v1/businesses/${businessId}/queue`).set(...bearer(token));
    expect(view.status).toBe(200);
    expect(view.body.data.count).toBe(2);
    expect(view.body.data.entries.map((e: { customerName: string }) => e.customerName)).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
    ]);
    expect(view.body.data.entries[0]).toMatchObject({ position: 1, discountPercent: 5 });
    expect(view.body.data.schedule.tiers).toHaveLength(2);
    expect(view.body.data.activeSessionId).toBe(sessionId);

    // The public queue read must NOT carry customer names (privacy).
    const pub = await request(app).get(`/api/v1/queues/business/${businessId}`);
    expect(JSON.stringify(pub.body.data)).not.toContain('Ada Lovelace');

    // A non-owner cannot read the manage view.
    await seedUser({ authProviderId: 'p2m|other', roles: ['vendor'] });
    const other = await mintToken('p2m|other');
    const forbidden = await request(app).get(`/api/v1/businesses/${businessId}/queue`).set(...bearer(other));
    expect(forbidden.status).toBe(403);

    // Serve the front (Ada) → the line advances: Grace becomes #1, Ada is gone.
    const served = await request(app)
      .post(`/api/v1/businesses/${businessId}/queue/serve-next`)
      .set(...bearer(token));
    expect(served.status).toBe(200);
    expect(served.body.data).toMatchObject({ servedCustomerName: 'Ada Lovelace', remaining: 1 });
    const advanced = await request(app).get(`/api/v1/businesses/${businessId}/queue`).set(...bearer(token));
    expect(advanced.body.data.count).toBe(1);
    expect(advanced.body.data.entries[0]).toMatchObject({ position: 1, customerName: 'Grace Hopper' });

    // A non-owner cannot serve someone else's line.
    const cantServe = await request(app)
      .post(`/api/v1/businesses/${businessId}/queue/serve-next`)
      .set(...bearer(other));
    expect(cantServe.status).toBe(403);
  });
});

describe('vendor payouts overview (V-12)', () => {
  /**
   * The payouts screen was fully hardcoded ("Stripe account active"). It now reads real connection
   * status (re-synced live from Stripe, so it's honest even without the webhook), the connected
   * account balance, and the earnings ledger.
   */
  it('reports not-connected before onboarding, then verifying, then active with a balance', async () => {
    const categoryId = await openCategory('p2-payouts');
    await seedUser({ authProviderId: 'p2po|vendor', roles: ['vendor'] });
    const token = await mintToken('p2po|vendor');
    const created = await request(app)
      .post('/api/v1/businesses')
      .set(...bearer(token))
      .send({ name: 'Payout Truck', categoryId });
    const businessId = created.body.data.id as string;

    // Before onboarding: no account, no balance, empty ledger.
    const before = await request(app)
      .get(`/api/v1/businesses/${businessId}/payouts`)
      .set(...bearer(token));
    expect(before.status).toBe(200);
    expect(before.body.data.account).toMatchObject({ connected: false, chargesEnabled: false });
    expect(before.body.data.balance).toBeNull();
    expect(before.body.data.earnings).toEqual([]);

    // Onboard creates the account — connected, but Stripe hasn't enabled charges yet (verifying).
    await request(app).post(`/api/v1/businesses/${businessId}/payouts/onboard`).set(...bearer(token));
    const verifying = await request(app)
      .get(`/api/v1/businesses/${businessId}/payouts`)
      .set(...bearer(token));
    expect(verifying.body.data.account).toMatchObject({ connected: true, chargesEnabled: false });

    // Stripe finishes verification and the account carries a balance.
    const acct = await ConnectedAccountModel.findOne({ owner_type: 'business', owner_id: businessId }).lean();
    fakeStripe.enableAccount(acct!.stripe_account_id);
    fakeStripe.setBalance(acct!.stripe_account_id, 48200, 12600);
    const active = await request(app)
      .get(`/api/v1/businesses/${businessId}/payouts`)
      .set(...bearer(token));
    expect(active.body.data.account).toMatchObject({
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: true,
    });
    expect(active.body.data.balance).toMatchObject({ availableCents: 48200, pendingCents: 12600 });

    // The read-through also synced our store, so the go-live/charge gate sees enabled too.
    const synced = await ConnectedAccountModel.findOne({ owner_id: businessId }).lean();
    expect(synced!.charges_enabled).toBe(true);
  });

  /**
   * A charge can succeed at Stripe while our ledger never hears about it (missed
   * `payment_intent.succeeded` webhook). It then sits as `pending` forever: excluded from "earned"
   * yet present in the Stripe balance — which is exactly why the two numbers disagreed. Reading the
   * intent back on the payouts fetch settles it.
   */
  it('settles a paid-at-Stripe charge our ledger still calls pending, so earnings match reality', async () => {
    const categoryId = await openCategory('p2-recon');
    const { token, businessId } = await vendorWithLiveBusiness('p2rc', categoryId, -121.7, 38.3);
    const acct = await ConnectedAccountModel.findOne({ owner_id: businessId }).lean();

    await TransactionModel.create({
      customer_id: 'cust_recon',
      counterparty_type: 'business',
      counterparty_id: businessId,
      connected_account_id: acct!.stripe_account_id,
      amount_cents: 11800,
      platform_fee_cents: 1180,
      currency: 'usd',
      fee_breakdown: { platform_cents: 1180, counterparty_net_cents: 10620 },
      status: 'pending',
      idempotency_key: 'p2rc-pending-1',
      transfer_group: 'tg_p2rc',
      payment_intent_ref: 'pi_p2rc_1',
    });

    // Before: invisible in earnings (the list only surfaces completed sales).
    const before = await request(app)
      .get(`/api/v1/businesses/${businessId}/payouts`)
      .set(...bearer(token));
    // The very act of reading reconciles it, so assert on the *result* of that read.
    expect(before.body.data.summary.netEarnedCents).toBe(10620);
    expect(before.body.data.summary.salesCount).toBe(1);

    // The ledger itself was corrected — not just the display.
    const settled = await TransactionModel.findOne({ payment_intent_ref: 'pi_p2rc_1' }).lean();
    expect(settled!.status).toBe('completed');
    expect(settled!.completed_at).toBeTruthy();
  });

  it('only the owner can read a business payouts overview', async () => {
    const categoryId = await openCategory('p2-payouts-authz');
    const { businessId } = await vendorWithLiveBusiness('p2poa', categoryId, -121.4, 38.0);
    await seedUser({ authProviderId: 'p2poa|other', roles: ['vendor'] });
    const other = await mintToken('p2poa|other');
    const res = await request(app)
      .get(`/api/v1/businesses/${businessId}/payouts`)
      .set(...bearer(other));
    expect(res.status).toBe(403);
  });
});

describe('follow / notify-me', () => {
  it('follows a business, lists it in favorites with its live status, and registers notify-me', async () => {
    const categoryId = await openCategory('p2-follow');
    const { businessId } = await vendorWithLiveBusiness('p2f', categoryId, -121.2, 37.8);
    await seedUser({ authProviderId: 'p2f|cust', roles: ['customer'] });
    const cust = await mintToken('p2f|cust');

    const follow = await request(app)
      .post(`/api/v1/businesses/${businessId}/follow`)
      .set(...bearer(cust));
    expect(follow.status).toBe(200);

    const favs = await request(app)
      .get('/api/v1/users/me/favorites')
      .set(...bearer(cust));
    const entry = favs.body.data.find((f: { businessId: string }) => f.businessId === businessId);
    expect(entry).toBeTruthy();
    expect(entry.status).toBe('parked');

    const notify = await request(app)
      .post(`/api/v1/businesses/${businessId}/notify-me`)
      .set(...bearer(cust));
    expect(notify.status).toBe(201);
  });
});

describe('reviews (tied to a completed transaction)', () => {
  it('allows one review per completed transaction and rejects duplicates/non-participants', async () => {
    const categoryId = await openCategory('p2-review');
    const { businessId } = await vendorWithLiveBusiness('p2r', categoryId, -121.3, 37.9);
    await seedUser({ authProviderId: 'p2r|cust', roles: ['customer'] });
    await seedUser({ authProviderId: 'p2r|other', roles: ['customer'] });
    const cust = await mintToken('p2r|cust');
    const other = await mintToken('p2r|other');

    const checkout = await request(app)
      .post(`/api/v1/queues/business/${businessId}/checkout`)
      .set(...bearer(cust))
      .set('Idempotency-Key', 'p2r-checkout')
      .send({ baseAmountCents: 800 });
    const transactionId = checkout.body.data.transactionId as string;
    const paymentIntentRef = checkout.body.data.paymentIntentRef as string;
    await stripeEvent('payment_intent.succeeded', { id: paymentIntentRef });

    const review = await request(app)
      .post('/api/v1/reviews')
      .set(...bearer(cust))
      .send({
        subjectType: 'business',
        subjectId: businessId,
        rating: 5,
        comment: 'great',
        transactionId,
      });
    expect(review.status).toBe(201);

    // A different user cannot review someone else's transaction.
    const notMine = await request(app)
      .post('/api/v1/reviews')
      .set(...bearer(other))
      .send({ subjectType: 'business', subjectId: businessId, rating: 1, transactionId });
    expect(notMine.status).toBe(403);

    // No second review for the same transaction.
    const dup = await request(app)
      .post('/api/v1/reviews')
      .set(...bearer(cust))
      .send({ subjectType: 'business', subjectId: businessId, rating: 4, transactionId });
    expect(dup.status).toBe(409);

    const list = await request(app)
      .get('/api/v1/reviews')
      .query({ subjectType: 'business', subjectId: businessId });
    expect(list.body.data.count).toBe(1);
    expect(list.body.data.average).toBe(5);
  });

  /**
   * CU-30 — photos on a review, and the moderation rule that governs them.
   *
   * Photos are the one part of a review that can do real harm: an explicit or hostile image sits on
   * a vendor's profile and the vendor cannot remove it. So reports hide the PHOTOS at a low
   * threshold — but never the rating or the words, which would hand every business a takedown
   * button for criticism it did not like.
   */
  it('CU-30: carries photos, and hides only the photos when reported', async () => {
    const categoryId = await openCategory('p2-revphotos');
    const { token: vendorToken, businessId } = await vendorWithLiveBusiness(
      'p2rp',
      categoryId,
      -121.7,
      37.2,
    );
    await seedUser({ authProviderId: 'p2rp|cust', roles: ['customer'] });
    const cust = await mintToken('p2rp|cust');
    await seedUser({ authProviderId: 'p2rp|a', roles: ['customer'] });
    await seedUser({ authProviderId: 'p2rp|b', roles: ['customer'] });
    const reporterA = await mintToken('p2rp|a');
    const reporterB = await mintToken('p2rp|b');

    await request(app)
      .post(`/api/v1/queues/business/${businessId}/join`)
      .set(...bearer(cust));
    const checkout = await request(app)
      .post(`/api/v1/queues/business/${businessId}/checkout`)
      .set(...bearer(cust))
      .set('Idempotency-Key', 'p2rp-1')
      .send({ baseAmountCents: 1000 });
    const transactionId = checkout.body.data.transactionId as string;
    await stripeEvent('payment_intent.succeeded', {
      id: (await TransactionModel.findById(transactionId).lean())!.payment_intent_ref,
    });

    const review = await request(app)
      .post('/api/v1/reviews')
      .set(...bearer(cust))
      .send({
        subjectType: 'business',
        subjectId: businessId,
        rating: 4,
        comment: 'Good birria',
        photos: ['https://cdn.test/plate.jpg'],
        transactionId,
      });
    expect(review.status).toBe(201);

    const visible = await request(app)
      .get('/api/v1/reviews')
      .query({ subjectType: 'business', subjectId: businessId });
    expect(visible.body.data.reviews[0].photos).toEqual(['https://cdn.test/plate.jpg']);

    const reviewId = String(
      (await (await import('../src/modules/reviews/reviews.model')).ReviewModel.findOne({
        transaction_id: transactionId,
      }).lean())!._id,
    );
    await request(app)
      .post(`/api/v1/reviews/${reviewId}/report-photos`)
      .set(...bearer(reporterA))
      .send({ reason: 'not the food' })
      .expect(200);
    const afterOne = await request(app)
      .get('/api/v1/reviews')
      .query({ subjectType: 'business', subjectId: businessId });
    // One report is a disagreement, not a signal.
    expect(afterOne.body.data.reviews[0].photos).toHaveLength(1);

    await request(app)
      .post(`/api/v1/reviews/${reviewId}/report-photos`)
      .set(...bearer(reporterB))
      .send({})
      .expect(200);

    const afterTwo = await request(app)
      .get('/api/v1/reviews')
      .query({ subjectType: 'business', subjectId: businessId });
    const row = afterTwo.body.data.reviews[0];
    expect(row.photos).toHaveLength(0);
    expect(row.photosHidden).toBe(true);
    /**
     * The load-bearing assertion: the criticism survives. A business that could bury a 4-star
     * review by reporting its photo would have been given a censorship tool.
     */
    expect(row.rating).toBe(4);
    expect(row.comment).toBe('Good birria');
    expect(afterTwo.body.data.count).toBe(1);
    void vendorToken;
  });
});

describe('sweeps', () => {
  it('expires an overdue pending wave-down', async () => {
    const categoryId = await openCategory('p2-sweep-wave');
    const { businessId } = await vendorWithLiveBusiness('p2sw', categoryId, -121.4, 38.0);
    await seedUser({ authProviderId: 'p2sw|cust', roles: ['customer'] });
    const cust = await mintToken('p2sw|cust');

    const wave = await request(app)
      .post('/api/v1/wave-downs')
      .set(...bearer(cust))
      .send({ targetType: 'business', targetId: businessId });
    // Age it past its SLA, then run the sweep.
    await WaveDownModel.updateOne(
      { _id: wave.body.data.id },
      { $set: { expires_at: new Date(Date.now() - 1000) } },
    );
    const expired = await queueService.expireWaveDowns();
    expect(expired).toBeGreaterThanOrEqual(1);
    const after = await WaveDownModel.findById(wave.body.data.id).lean();
    expect(after!.status).toBe('expired');
  });

  it('ends a stale live session', async () => {
    const categoryId = await openCategory('p2-sweep-stale');
    const { sessionId } = await vendorWithLiveBusiness('p2ss', categoryId, -121.5, 38.1);
    await LiveSessionModel.updateOne(
      { _id: sessionId },
      { $set: { last_ping_at: new Date(Date.now() - 5 * 60 * 1000) } },
    );
    const ended = await livemapService.expireStaleSessions();
    expect(ended).toBeGreaterThanOrEqual(1);
    const after = await LiveSessionModel.findById(sessionId).lean();
    expect(after!.status).toBe('away_closed');
    expect(after!.ended_at).toBeTruthy();
  });

  it('releases an expired queue hold', async () => {
    const categoryId = await openCategory('p2-sweep-hold');
    const { businessId } = await vendorWithLiveBusiness('p2sh', categoryId, -121.6, 38.2);
    const custId = await seedUser({ authProviderId: 'p2sh|cust', roles: ['customer'] });
    const cust = await mintToken('p2sh|cust');
    await request(app).post(`/api/v1/queues/business/${businessId}/join`).set(...bearer(cust));
    // The join response is the customer's membership (no entryId) — find the entry by customer.
    const entry = await QueueEntryModel.findOne({ customer_id: custId }).lean();
    await QueueEntryModel.updateOne(
      { _id: entry!._id },
      { $set: { hold_expires_at: new Date(Date.now() - 1000) } },
    );
    const released = await queueService.expireHolds();
    expect(released).toBeGreaterThanOrEqual(1);
    const after = await QueueEntryModel.findById(entry!._id).lean();
    expect(after!.left_at).toBeTruthy();
  });
});

describe('Trending (R1b)', () => {
  /**
   * The R1 incentive made measurable: discounting is rewarded with placement, but never required.
   * Both vendors are live at the same coordinates at the same moment, so proximity/recency/demand
   * are equal and the discount boost is the only differing signal.
   */
  it('ranks a discounting vendor above an identical non-discounting one, without gating', async () => {
    const categoryId = await openCategory('p2-trending');
    const a = await vendorWithLiveBusiness('p2tA', categoryId, -121.9, 37.5);
    const b = await vendorWithLiveBusiness('p2tB', categoryId, -121.9, 37.5);

    await request(app)
      .put(`/api/v1/queues/business/${a.businessId}/discount-schedule`)
      .set(...bearer(a.token))
      .send({ tiers: [{ position: 1, discount_percent: 20 }], capPercent: 20 });

    const res = await request(app)
      .get('/api/v1/map/trending')
      .query({ lat: 37.5, lng: -121.9, limit: 50 });
    expect(res.status).toBe(200);

    const rows = res.body.data as { businessId: string; score: number; discountPercent: number; factors: string[] }[];
    const ia = rows.findIndex((r) => r.businessId === a.businessId);
    const ib = rows.findIndex((r) => r.businessId === b.businessId);

    // A discount is a BOOST, not a gate — the non-discounting vendor is still listed.
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ib).toBeGreaterThanOrEqual(0);
    // …and the discounting vendor measurably outranks the identical non-discounting one.
    expect(ia).toBeLessThan(ib);
    expect(rows[ia]!.score).toBeGreaterThan(rows[ib]!.score);
    expect(rows[ia]!.discountPercent).toBe(20);
    expect(rows[ia]!.factors.join(' ')).toMatch(/20% off/);
    expect(rows[ib]!.discountPercent).toBe(0);
  });

  it('works without a location — proximity simply scores 0', async () => {
    const res = await request(app).get('/api/v1/map/trending').query({ limit: 5 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
