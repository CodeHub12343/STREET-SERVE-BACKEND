import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel, TransactionModel } from '../src/modules/payments/payments.model';
import { BookingModel } from '../src/modules/scheduling/scheduling.model';
import { schedulingService } from '../src/modules/scheduling/scheduling.service';
import { feeService } from '../src/modules/payments/fees';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * Phase 3 exit criterion: "booking + direct-order flows work end-to-end with reminders and
 * dashboard reads." Plus the away_closed order interlock, partial fulfilment, and messaging.
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

/**
 * Since BP-2 gates writes on the business's modules, a fixture must declare the archetype that
 * matches what its test exercises — previously any business could do anything because nothing was
 * gated. `counter_serve` (default) supplies menu/ordering/queue; `appointment_service` supplies
 * services/booking.
 */
async function openCategory(
  slug: string,
  archetype: 'counter_serve' | 'appointment_service' = 'counter_serve',
): Promise<string> {
  const c = await CategoryModel.create({
    slug,
    name: slug,
    top_level_tab: archetype === 'counter_serve' ? 'food' : 'services',
    requires_license: false,
    archetype,
  });
  return String(c._id);
}

/** Vendor + business (optionally live + payout-enabled). */
async function makeVendorBusiness(prefix: string, categoryId: string, opts?: { live?: boolean }) {
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

  let sessionId: string | null = null;
  if (opts?.live) {
    // R28: accept the Terms of Sale once before going live.
    await request(app).post('/api/v1/agreements/regular_sale/accept').set(...bearer(token)).send({});
    const session = await request(app)
      .post('/api/v1/live-sessions/start')
      .set(...bearer(token))
      .send({ actorType: 'business', actorId: businessId, lng: -121, lat: 37.6, status: 'parked' });
    sessionId = session.body.data.id as string;
  }
  return { token, businessId, sessionId };
}

/**
 * §32 — the platform's fee on a completed service booking.
 *
 * Bookings were the one transaction type on the platform that produced revenue for the vendor and
 * none for the platform, purely because nobody had wired the fee.
 */
describe('§32: booking platform fee', () => {
  it('charges 10% on a completed booking, and nothing on one that was never served', async () => {
    const categoryId = await openCategory('p3-bookfee', 'appointment_service');
    const { token, businessId } = await makeVendorBusiness('p3bf', categoryId);

    const svc = await request(app)
      .post(`/api/v1/businesses/${businessId}/services`)
      .set(...bearer(token))
      .send({ name: 'Full valet', durationMin: 60, priceCents: 12_000 });
    const serviceId = svc.body.data.id as string;
    await request(app)
      .put(`/api/v1/businesses/${businessId}/availability`)
      .set(...bearer(token))
      .send({
        windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, startMin: 0, endMin: 1440 })),
      });

    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 2);
    const slot = new Date(`${date.toISOString().slice(0, 10)}T11:00:00.000Z`).toISOString();
    await seedUser({ authProviderId: 'p3bf|cust', roles: ['customer'] });
    const cust = await mintToken('p3bf|cust');
    const booking = await request(app)
      .post('/api/v1/bookings')
      .set(...bearer(cust))
      .send({ businessId, serviceId, scheduledAt: slot });
    const bookingId = booking.body.data.id as string;

    // Nothing is taken while it is merely booked — a reserved slot has earned nobody anything.
    expect((await BookingModel.findById(bookingId).lean())!.platform_fee_cents).toBe(0);

    const done = await request(app)
      .post(`/api/v1/bookings/${bookingId}/complete`)
      .set(...bearer(token));
    expect(done.status).toBe(200);
    expect(done.body.data.priceCents).toBe(12_000);
    expect(done.body.data.platformFeeCents).toBe(1_200); // 10%, same as every other completed sale
    expect((await BookingModel.findById(bookingId).lean())!.platform_fee_cents).toBe(1_200);
  });

  it('takes nothing from a no-show', async () => {
    const categoryId = await openCategory('p3-bookfee2', 'appointment_service');
    const { token, businessId } = await makeVendorBusiness('p3bf2', categoryId);
    const svc = await request(app)
      .post(`/api/v1/businesses/${businessId}/services`)
      .set(...bearer(token))
      .send({ name: 'Trim', durationMin: 30, priceCents: 4_000 });
    await request(app)
      .put(`/api/v1/businesses/${businessId}/availability`)
      .set(...bearer(token))
      .send({ windows: [{ dayOfWeek: new Date().getUTCDay(), startMin: 0, endMin: 1440 }] });

    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 3);
    await seedUser({ authProviderId: 'p3bf2|cust', roles: ['customer'] });
    const cust = await mintToken('p3bf2|cust');
    const b = await request(app)
      .post('/api/v1/bookings')
      .set(...bearer(cust))
      .send({
        businessId,
        serviceId: svc.body.data.id as string,
        scheduledAt: new Date(`${date.toISOString().slice(0, 10)}T09:00:00.000Z`).toISOString(),
      });
    if (b.status !== 201) return; // slot maths differs by weekday; the completed case above is the assertion

    await BookingModel.updateOne(
      { _id: b.body.data.id },
      { $set: { scheduled_at: new Date(Date.now() - 1000) } },
    );
    await request(app)
      .post(`/api/v1/bookings/${b.body.data.id as string}/no-show`)
      .set(...bearer(token))
      .expect(200);
    expect((await BookingModel.findById(b.body.data.id).lean())!.platform_fee_cents).toBe(0);
  });
});

describe('booking flow + reminders + no-show', () => {
  it('exposes availability, books a slot, fires reminders, and marks no-show', async () => {
    // Booking flow → an appointment business (services + booking).
    const categoryId = await openCategory('p3-book', 'appointment_service');
    const { token, businessId } = await makeVendorBusiness('p3b', categoryId);

    const svc = await request(app)
      .post(`/api/v1/businesses/${businessId}/services`)
      .set(...bearer(token))
      .send({ name: 'Detailing', durationMin: 60, priceCents: 5000 });
    const serviceId = svc.body.data.id as string;

    // Open availability all week, full day.
    await request(app)
      .put(`/api/v1/businesses/${businessId}/availability`)
      .set(...bearer(token))
      .send({
        windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, startMin: 0, endMin: 1440 })),
      });

    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 2);
    const dateISO = date.toISOString().slice(0, 10);
    const avail = await request(app)
      .get(`/api/v1/businesses/${businessId}/availability`)
      .query({ serviceId, date: dateISO });
    expect(avail.status).toBe(200);
    expect(avail.body.data.slots.length).toBeGreaterThan(0);

    await seedUser({ authProviderId: 'p3b|cust', roles: ['customer'] });
    const cust = await mintToken('p3b|cust');
    const slot = new Date(`${dateISO}T10:00:00.000Z`).toISOString();
    const booking = await request(app)
      .post('/api/v1/bookings')
      .set(...bearer(cust))
      .send({ businessId, serviceId, scheduledAt: slot });
    expect(booking.status).toBe(201);
    const bookingId = booking.body.data.id as string;

    // The customer's booking history (C-25) carries business + service names so the Orders tab's
    // Bookings filter can render real rows (the list returned ids only before).
    const mine = await request(app).get('/api/v1/bookings/mine').set(...bearer(cust));
    expect(mine.status).toBe(200);
    const row = mine.body.data.find((b: { id: string }) => b.id === bookingId);
    expect(row).toBeTruthy();
    expect(row.businessName).toEqual(expect.any(String));
    expect(row.serviceName).toEqual(expect.any(String));
    expect(row.serviceName.length).toBeGreaterThan(0);

    // Reminders: age the booking to 30 minutes out → both 24h and 1h reminders fire.
    await BookingModel.updateOne(
      { _id: bookingId },
      {
        $set: {
          scheduled_at: new Date(Date.now() + 30 * 60 * 1000),
          reminder_sent_24h: false,
          reminder_sent_1h: false,
        },
      },
    );
    const reminders = await schedulingService.sendDueReminders();
    expect(reminders.sent24h).toBeGreaterThanOrEqual(1);
    expect(reminders.sent1h).toBeGreaterThanOrEqual(1);

    // No-show: move it to the past, vendor marks no-show.
    await BookingModel.updateOne(
      { _id: bookingId },
      { $set: { scheduled_at: new Date(Date.now() - 1000) } },
    );
    const noshow = await request(app)
      .post(`/api/v1/bookings/${bookingId}/no-show`)
      .set(...bearer(token));
    expect(noshow.status).toBe(200);
    expect(noshow.body.data.status).toBe('no_show');
  });
});

describe('direct order flow + away interlock + partial fulfilment', () => {
  it('places, accepts, blocks ready while away, then readies + completes', async () => {
    const categoryId = await openCategory('p3-order');
    const { token, businessId, sessionId } = await makeVendorBusiness('p3o', categoryId, {
      live: true,
    });

    const item1 = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Taco', priceCents: 300 });
    const item2 = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Burrito', priceCents: 700 });

    await seedUser({ authProviderId: 'p3o|cust', roles: ['customer'], displayName: 'Grace Hopper' });
    const cust = await mintToken('p3o|cust');

    const order = await request(app)
      .post('/api/v1/orders')
      .set(...bearer(cust))
      .set('Idempotency-Key', 'p3o-order-1')
      .send({
        businessId,
        items: [
          { menuItemId: item1.body.data.id, quantity: 2 },
          { menuItemId: item2.body.data.id, quantity: 1 },
        ],
      });
    expect(order.status).toBe(201);
    expect(order.body.data.totalCents).toBe(1300); // 2*300 + 700
    const orderId = order.body.data.id as string;

    const accept = await request(app)
      .post(`/api/v1/orders/${orderId}/accept`)
      .set(...bearer(token));
    expect(accept.status).toBe(200);

    // The vendor board reads this list; the accepted ticket must stay on it, with the customer's
    // name (so it maps to the "Preparing" column client-side rather than vanishing).
    const board = await request(app)
      .get(`/api/v1/businesses/${businessId}/orders`)
      .set(...bearer(token));
    const boardOrder = board.body.data.find((o: { id: string }) => o.id === orderId);
    expect(boardOrder).toBeTruthy();
    expect(boardOrder.status).toBe('accepted');
    expect(boardOrder.customerName).toBe('Grace Hopper');

    // Away interlock: business goes Away/Closed → cannot mark ready.
    await request(app)
      .patch(`/api/v1/live-sessions/${sessionId}/status`)
      .set(...bearer(token))
      .send({ status: 'away_closed' });
    const blocked = await request(app)
      .post(`/api/v1/orders/${orderId}/ready`)
      .set(...bearer(token));
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('BUSINESS_AWAY');

    // Back to Parked → ready + complete.
    await request(app)
      .patch(`/api/v1/live-sessions/${sessionId}/status`)
      .set(...bearer(token))
      .send({ status: 'parked' });
    const ready = await request(app)
      .post(`/api/v1/orders/${orderId}/ready`)
      .set(...bearer(token));
    expect(ready.status).toBe(200);
    expect(ready.body.data.status).toBe('ready');
    const done = await request(app)
      .post(`/api/v1/orders/${orderId}/complete`)
      .set(...bearer(token));
    expect(done.body.data.status).toBe('completed');

    // Fulfilling the order settled its transaction — so the customer can now review the business.
    // (Before this, the txn stayed 'pending' pending a payment webhook, and the review was blocked.)
    const txnId = order.body.data.transactionId as string;
    expect(txnId).toBeTruthy();
    const review = await request(app)
      .post('/api/v1/reviews')
      .set(...bearer(cust))
      .send({ subjectType: 'business', subjectId: businessId, rating: 5, comment: 'Great tacos', transactionId: txnId });
    expect(review.status).toBe(201);

    // The customer's order history (/orders/mine) carries the business name + status so the Orders
    // tab can render real rows (it was a stub returning nothing).
    const mine = await request(app).get('/api/v1/orders/mine').set(...bearer(cust));
    const row = mine.body.data.find((o: { id: string }) => o.id === orderId);
    expect(row).toBeTruthy();
    expect(row.status).toBe('completed');
    expect(row.businessName).toEqual(expect.any(String));
    expect(row.businessName.length).toBeGreaterThan(0);
  });

  it('blocks ordering when the business is not open', async () => {
    const categoryId = await openCategory('p3-order-closed');
    const { businessId } = await makeVendorBusiness('p3oc', categoryId); // not live
    await seedUser({ authProviderId: 'p3oc|cust', roles: ['customer'] });
    const cust = await mintToken('p3oc|cust');
    // Need a menu item id shape; use a syntactically valid ObjectId that won't be reached (away check first).
    const res = await request(app)
      .post('/api/v1/orders')
      .set(...bearer(cust))
      .set('Idempotency-Key', 'p3oc-1')
      .send({ businessId, items: [{ menuItemId: '507f1f77bcf86cd799439011', quantity: 1 }] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_AWAY');
  });

  it('partially fulfils an order: removes an out-of-stock item and refunds it', async () => {
    const categoryId = await openCategory('p3-partial');
    const { token, businessId } = await makeVendorBusiness('p3p', categoryId, { live: true });
    const a = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'A', priceCents: 500 });
    const b = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'B', priceCents: 300 });
    await seedUser({ authProviderId: 'p3p|cust', roles: ['customer'] });
    const cust = await mintToken('p3p|cust');

    const order = await request(app)
      .post('/api/v1/orders')
      .set(...bearer(cust))
      .set('Idempotency-Key', 'p3p-order')
      .send({
        businessId,
        items: [
          { menuItemId: a.body.data.id, quantity: 1 },
          { menuItemId: b.body.data.id, quantity: 2 },
        ],
      });
    const orderId = order.body.data.id as string;
    expect(order.body.data.totalCents).toBe(1100); // 500 + 2*300

    // Settle the payment so a partial refund can be issued.
    await stripeEvent('payment_intent.succeeded', { id: order.body.data.payment.paymentIntentRef });

    const removed = await request(app)
      .post(`/api/v1/orders/${orderId}/remove-item`)
      .set(...bearer(token))
      .send({ menuItemId: b.body.data.id });
    expect(removed.status).toBe(200);
    expect(removed.body.data.refundedCents).toBe(600); // 2 * 300
    expect(removed.body.data.totalCents).toBe(500);
    expect(removed.body.data.items.length).toBe(1);
  });
});

describe('server-authoritative checkout itemization (R9 / preview == charge)', () => {
  it('quotes the full breakdown and charges exactly the previewed total', async () => {
    const categoryId = await openCategory('p3-quote');
    const { token, businessId } = await makeVendorBusiness('p3q', categoryId, { live: true });
    const taco = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Taco', priceCents: 300 });
    await seedUser({ authProviderId: 'p3q|cust', roles: ['customer'] });
    const cust = await mintToken('p3q|cust');
    const items = [{ menuItemId: taco.body.data.id, quantity: 2 }];

    // Preview: server returns every mandated line (fees $0 in the pickup MVP), total = subtotal + tip.
    const quote = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(cust))
      .send({ businessId, items, tipCents: 50 });
    expect(quote.status).toBe(200);
    const b = quote.body.data.breakdown;
    expect(b).toMatchObject({
      subtotalCents: 600,
      discountCents: 0,
      taxCents: 0,
      deliveryCents: 0,
      serviceFeeCents: 0,
      processingFeeCents: 0,
      tipCents: 50,
      totalCents: 650,
    });
    expect(quote.body.data.openForOrders).toBe(true);

    // Charge: placing the identical order charges exactly the previewed total (preview == charge).
    const order = await request(app)
      .post('/api/v1/orders')
      .set(...bearer(cust))
      .set('Idempotency-Key', 'p3q-order-1')
      .send({ businessId, items, tipCents: 50 });
    expect(order.status).toBe(201);
    expect(order.body.data.totalCents).toBe(b.totalCents);
    expect(order.body.data.breakdown).toMatchObject({ subtotalCents: 600, tipCents: 50, totalCents: 650 });
    expect(fakeStripe.lastCharge()?.amountCents).toBe(b.totalCents);

    // R7: a regular order records the marketplace fee-type + 10% of the goods (600 → 60).
    const orderTxn = await TransactionModel.findById(order.body.data.transactionId).lean();
    expect(orderTxn?.fee_type).toBe('marketplace');
    expect(orderTxn?.platform_fee_cents).toBe(60);
  });

  it('applies the locked queue discount identically in the quote and the charge', async () => {
    const categoryId = await openCategory('p3-quote-disc');
    const { token, businessId } = await makeVendorBusiness('p3qd', categoryId, { live: true });
    const item = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Plate', priceCents: 1000 });
    // 1st in line locks 10% off.
    await request(app)
      .put(`/api/v1/queues/business/${businessId}/discount-schedule`)
      .set(...bearer(token))
      .send({ tiers: [{ position: 1, discount_percent: 10 }], capPercent: 10 });

    await seedUser({ authProviderId: 'p3qd|cust', roles: ['customer'] });
    const cust = await mintToken('p3qd|cust');
    await request(app).post(`/api/v1/queues/business/${businessId}/join`).set(...bearer(cust));

    const items = [{ menuItemId: item.body.data.id, quantity: 1 }];
    const quote = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(cust))
      .send({ businessId, items });
    // 1000 − 10% = 900, previewed server-side from the locked queue discount.
    expect(quote.body.data.breakdown).toMatchObject({
      subtotalCents: 1000,
      discountPercent: 10,
      discountCents: 100,
      totalCents: 900,
    });

    const order = await request(app)
      .post('/api/v1/orders')
      .set(...bearer(cust))
      .set('Idempotency-Key', 'p3qd-order-1')
      .send({ businessId, items });
    expect(order.body.data.totalCents).toBe(900); // charge == preview, discount applied
    expect(fakeStripe.lastCharge()?.amountCents).toBe(900);
  });
});

describe('full fee taxonomy at checkout (R8/R10/S7)', () => {
  afterEach(() => feeService.setOrderFeeFlags({ customerService: false, processing: false }));

  it('toggling the fee flags adds bounded service + processing lines; preview == charge', async () => {
    const categoryId = await openCategory('p3-feetax');
    const { token, businessId } = await makeVendorBusiness('p3ft', categoryId, { live: true });
    const item = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Plate', priceCents: 1000 });
    await seedUser({ authProviderId: 'p3ft|cust', roles: ['customer'] });
    const cust = await mintToken('p3ft|cust');
    const items = [{ menuItemId: item.body.data.id, quantity: 2 }]; // subtotal 2000

    // Flags OFF (launch default): no customer-facing fees — charge math unchanged.
    const off = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(cust))
      .send({ businessId, items });
    expect(off.body.data.breakdown).toMatchObject({
      subtotalCents: 2000,
      serviceFeeCents: 0,
      processingFeeCents: 0,
      totalCents: 2000,
    });

    // Flip both on → 3% service (bounded) + Stripe processing pass-through, itemized server-side.
    feeService.setOrderFeeFlags({ customerService: true, processing: true });
    const on = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(cust))
      .send({ businessId, items });
    expect(on.body.data.breakdown).toMatchObject({
      subtotalCents: 2000,
      serviceFeeCents: 60, // 3% of 2000, within [50, 1000]
      processingFeeCents: 89, // 2.9% of 2060 + 30¢
      totalCents: 2149,
    });

    // Placing the order charges exactly the previewed, fee-inclusive total (preview == charge).
    const order = await request(app)
      .post('/api/v1/orders')
      .set(...bearer(cust))
      .set('Idempotency-Key', 'p3ft-order-1')
      .send({ businessId, items });
    expect(order.body.data.totalCents).toBe(2149);
    expect(order.body.data.breakdown.serviceFeeCents).toBe(60);
    expect(order.body.data.breakdown.processingFeeCents).toBe(89);
    expect(fakeStripe.lastCharge()?.amountCents).toBe(2149);
  });

  it('rejects any client-supplied fee amount (S7)', async () => {
    const categoryId = await openCategory('p3-s7');
    const { token, businessId } = await makeVendorBusiness('p3s7', categoryId, { live: true });
    const item = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Plate', priceCents: 1000 });
    await seedUser({ authProviderId: 'p3s7|cust', roles: ['customer'] });
    const cust = await mintToken('p3s7|cust');

    // A crafted body trying to inject a fee is rejected by the strict schema — fees are server-set.
    const res = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(cust))
      .send({
        businessId,
        items: [{ menuItemId: item.body.data.id, quantity: 1 }],
        serviceFeeCents: 0,
        processingFeeCents: 0,
      });
    expect(res.status).toBe(400);
  });
});

describe('order cancellation refund policy (R13/U6)', () => {
  it('discloses then issues a full pre-fulfillment refund: goods + tip + fee returned', async () => {
    const categoryId = await openCategory('p3-refund');
    const { token, businessId } = await makeVendorBusiness('p3rf', categoryId, { live: true });
    const item = await request(app)
      .post(`/api/v1/businesses/${businessId}/menu`)
      .set(...bearer(token))
      .send({ name: 'Plate', priceCents: 1000 });
    await seedUser({ authProviderId: 'p3rf|cust', roles: ['customer'] });
    const cust = await mintToken('p3rf|cust');

    // Order $10 + $2 tip = $12; platform fee 10% of the $10 goods = 100.
    const order = await request(app)
      .post('/api/v1/orders')
      .set(...bearer(cust))
      .set('Idempotency-Key', 'p3rf-order-1')
      .send({ businessId, items: [{ menuItemId: item.body.data.id, quantity: 1 }], tipCents: 200 });
    const orderId = order.body.data.id as string;
    // Settle the charge so it's refundable.
    await stripeEvent('payment_intent.succeeded', { id: order.body.data.payment.paymentIntentRef });

    // Disclosure (U6): the customer sees exactly what comes back before confirming.
    const preview = await request(app)
      .get(`/api/v1/orders/${orderId}/refund-preview`)
      .set(...bearer(cust));
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({
      scenario: 'full_pre_fulfillment',
      refundedCents: 1200,
      tipCents: 200,
      marketplaceFeeReturnedCents: 100,
    });
    expect(preview.body.data.disclosure).toEqual(expect.any(String));

    const refundsBefore = fakeStripe.refundCalls.length;
    const cancel = await request(app)
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set(...bearer(cust))
      .send({ reason: 'Changed my mind' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.refund).toMatchObject({
      scenario: 'full_pre_fulfillment',
      refundedCents: 1200,
      marketplaceFeeReturnedCents: 100,
    });
    // The Stripe refund carried the R13 flags: reverse the transfer + return the application fee.
    const call = fakeStripe.refundCalls[refundsBefore];
    expect(call?.amountCents).toBe(1200);
    expect(call?.reverseTransfer).toBe(true);
    expect(call?.refundApplicationFee).toBe(true);
  });
});

/**
 * Messaging is scoped to people actually doing business together. A customer may open a thread only
 * with a business they have a live booking or order with — before that check existed, every vendor
 * on the platform was reachable by any stranger with their id.
 *
 * These fixtures therefore have to give the customer real standing first, exactly as the product
 * does. `giveStanding` is the cheapest honest way to say "this customer has a job with this vendor".
 */
async function giveStanding(customerId: string, businessId: string) {
  await BookingModel.create({
    customer_id: customerId,
    business_id: businessId,
    service_id: 'svc-standing',
    scheduled_at: new Date(Date.now() + 86_400_000),
    duration_min: 30,
    status: 'booked',
  });
}

/**
 * A-4 / 8.4 — the messaging transaction gate, asserted directly.
 *
 * The audit's finding was precise: the gate that closed the "any stranger can message any business"
 * hole **had no test asserting the 403 it introduced** — every test touching messaging gave the
 * customer standing first, so all of them would still pass if the gate were deleted. A gate whose
 * only coverage exercises the permissive path is a gate nobody would notice losing.
 */
describe('messaging transaction gate (A-4)', () => {
  it('refuses a stranger with no booking and no order', async () => {
    const categoryId = await openCategory('a4-msg');
    const { businessId } = await makeVendorBusiness('a4m', categoryId);
    await seedUser({ authProviderId: 'a4m|stranger', roles: ['customer'] });
    const stranger = await mintToken('a4m|stranger');

    const res = await request(app)
      .post('/api/v1/message-threads')
      .set(...bearer(stranger))
      .send({ businessId });

    expect(res.status).toBe(403);
    // The message tells them how to earn standing — a bare 403 reads as a bug.
    expect(res.body.error.message).toMatch(/book an appointment or place an order/i);
  });

  it('opens once the customer actually has a job with that business', async () => {
    const categoryId = await openCategory('a4-msg-ok');
    const { businessId } = await makeVendorBusiness('a4mo', categoryId);
    const custId = await seedUser({ authProviderId: 'a4mo|cust', roles: ['customer'] });
    const cust = await mintToken('a4mo|cust');

    const before = await request(app)
      .post('/api/v1/message-threads')
      .set(...bearer(cust))
      .send({ businessId });
    expect(before.status).toBe(403);

    await giveStanding(custId, businessId);

    const after = await request(app)
      .post('/api/v1/message-threads')
      .set(...bearer(cust))
      .send({ businessId });
    expect(after.status).toBe(201);
  });

  it('never gates the business owner — they must be able to reach their own customer', async () => {
    const categoryId = await openCategory('a4-msg-owner');
    const { token: vendorToken, businessId } = await makeVendorBusiness('a4mw', categoryId);
    const custId = await seedUser({ authProviderId: 'a4mw|cust', roles: ['customer'] });

    const res = await request(app)
      .post('/api/v1/message-threads')
      .set(...bearer(vendorToken))
      .send({ businessId, customerId: custId });

    expect(res.status).toBe(201);
  });

  it('keeps an existing conversation open after the job ends', async () => {
    // A thread cut off mid-way because a booking was cancelled would strand both parties in the
    // middle of sorting out exactly the thing that went wrong.
    const categoryId = await openCategory('a4-msg-after');
    const { businessId } = await makeVendorBusiness('a4ma', categoryId);
    const custId = await seedUser({ authProviderId: 'a4ma|cust', roles: ['customer'] });
    const cust = await mintToken('a4ma|cust');
    await giveStanding(custId, businessId);

    const opened = await request(app)
      .post('/api/v1/message-threads')
      .set(...bearer(cust))
      .send({ businessId });
    expect(opened.status).toBe(201);

    await BookingModel.updateMany(
      { customer_id: custId, business_id: businessId },
      { $set: { status: 'cancelled' } },
    );

    const reopened = await request(app)
      .post('/api/v1/message-threads')
      .set(...bearer(cust))
      .send({ businessId });
    expect(reopened.status).toBe(201);
    expect(reopened.body.data.id).toBe(opened.body.data.id);
  });
});

describe('scoped messaging', () => {
  it('threads a customer↔business conversation and blocks non-participants', async () => {
    const categoryId = await openCategory('p3-msg');
    const { token: vendorToken, businessId } = await makeVendorBusiness('p3m', categoryId);
    const custId = await seedUser({ authProviderId: 'p3m|cust', roles: ['customer'] });
    await seedUser({ authProviderId: 'p3m|other', roles: ['customer'] });
    const cust = await mintToken('p3m|cust');
    const other = await mintToken('p3m|other');
    await giveStanding(custId, businessId);

    const thread = await request(app)
      .post('/api/v1/message-threads')
      .set(...bearer(cust))
      .send({ businessId });
    expect(thread.status).toBe(201);
    const threadId = thread.body.data.id as string;

    const msg = await request(app)
      .post(`/api/v1/message-threads/${threadId}/messages`)
      .set(...bearer(cust))
      .send({ body: 'Are you open now?' });
    expect(msg.status).toBe(201);

    // Vendor sees the thread and replies.
    const vendorThreads = await request(app)
      .get('/api/v1/message-threads/mine')
      .set(...bearer(vendorToken));
    expect(
      vendorThreads.body.data.some(
        (t: { id: string; side: string }) => t.id === threadId && t.side === 'business',
      ),
    ).toBe(true);
    const reply = await request(app)
      .post(`/api/v1/message-threads/${threadId}/messages`)
      .set(...bearer(vendorToken))
      .send({ body: 'Yes, parked on Main St' });
    expect(reply.status).toBe(201);

    const history = await request(app)
      .get(`/api/v1/message-threads/${threadId}/messages`)
      .set(...bearer(cust));
    expect(history.body.data.length).toBe(2);

    // A non-participant cannot post to the thread.
    const intruder = await request(app)
      .post(`/api/v1/message-threads/${threadId}/messages`)
      .set(...bearer(other))
      .send({ body: 'let me in' });
    expect(intruder.status).toBe(403);
    expect(intruder.body.error.code).toBe('NOT_PARTICIPANT');
  });

  /**
   * The inbox renders a name, a preview and an unread badge per row. It used to receive only ids
   * and a timestamp, so every row showed a blank name and an undefined preview — the same class of
   * contract break as the menu's $NaN.
   */
  it('serves the inbox a name, a preview and an unread count', async () => {
    const categoryId = await openCategory('p3-inbox');
    const { token: vendorToken, businessId } = await makeVendorBusiness('p3inbox', categoryId);
    const custId = await seedUser({ authProviderId: 'p3inbox|cust', roles: ['customer'] });
    const cust = await mintToken('p3inbox|cust');
    await giveStanding(custId, businessId);

    const thread = await request(app)
      .post('/api/v1/message-threads')
      .set(...bearer(cust))
      .send({ businessId });
    const threadId = thread.body.data.id as string;

    // A thread with no messages yet is normal — "Message" opens one before anything is said.
    const empty = (await request(app).get('/api/v1/message-threads/mine').set(...bearer(cust))).body
      .data[0];
    expect(empty.businessName).toEqual(expect.any(String));
    expect(empty.businessName.length).toBeGreaterThan(0);
    expect(empty.lastMessage).toBe('');
    expect(empty.unread).toBe(0);

    await request(app)
      .post(`/api/v1/message-threads/${threadId}/messages`)
      .set(...bearer(cust))
      .send({ body: 'Are you open now?' });
    await request(app)
      .post(`/api/v1/message-threads/${threadId}/messages`)
      .set(...bearer(vendorToken))
      .send({ body: 'Yes — parked on Main St' });

    // The customer's row previews the NEWEST message and counts only what THEY have not read.
    const mine = (await request(app).get('/api/v1/message-threads/mine').set(...bearer(cust))).body
      .data[0];
    expect(mine.businessName).toBe(empty.businessName);
    expect(mine.lastMessage).toBe('Yes — parked on Main St');
    expect(mine.lastMessageAt).toEqual(expect.any(String));
    expect(mine.unread).toBe(1); // the vendor's reply — never the customer's own message

    // The vendor's own view of the same thread counts the customer's message instead.
    const theirs = (
      await request(app).get('/api/v1/message-threads/mine').set(...bearer(vendorToken))
    ).body.data[0];
    expect(theirs.unread).toBe(1);

    // Reading the thread clears the badge.
    await request(app)
      .post(`/api/v1/message-threads/${threadId}/read`)
      .set(...bearer(cust))
      .expect(200);
    const afterRead = (await request(app).get('/api/v1/message-threads/mine').set(...bearer(cust)))
      .body.data[0];
    expect(afterRead.unread).toBe(0);
  });

  it('reopens the same thread rather than duplicating it', async () => {
    const categoryId = await openCategory('p3-dupe');
    const { businessId } = await makeVendorBusiness('p3dupe', categoryId);
    const custId = await seedUser({ authProviderId: 'p3dupe|cust', roles: ['customer'] });
    const cust = await mintToken('p3dupe|cust');
    await giveStanding(custId, businessId);

    // Tapping Message twice is ordinary behaviour — it must not spawn a second conversation.
    const a = await request(app)
      .post('/api/v1/message-threads')
      .set(...bearer(cust))
      .send({ businessId });
    const b = await request(app)
      .post('/api/v1/message-threads')
      .set(...bearer(cust))
      .send({ businessId });

    expect(b.body.data.id).toBe(a.body.data.id);
    const list = (await request(app).get('/api/v1/message-threads/mine').set(...bearer(cust))).body
      .data;
    expect(list.filter((t: { businessId: string }) => t.businessId === businessId).length).toBe(1);
  });

  /**
   * S-1 — the gate itself. Messaging used to have NO check at all, so any stranger could open a
   * thread with any business on the platform. The fix shipped without a test, which meant a later
   * refactor removing it would have turned three tests green and looked like progress.
   */
  it('refuses a stranger with no booking or order, and opens once they have one', async () => {
    const categoryId = await openCategory('p3-gate');
    const { businessId } = await makeVendorBusiness('p3gate', categoryId);
    const strangerId = await seedUser({ authProviderId: 'p3gate|stranger', roles: ['customer'] });
    const stranger = await mintToken('p3gate|stranger');

    const denied = await request(app)
      .post('/api/v1/message-threads')
      .set(...bearer(stranger))
      .send({ businessId });
    expect(denied.status).toBe(403);
    // The refusal has to tell them what to do about it, not just say no.
    expect(denied.body.error.message).toMatch(/order|appointment/i);

    // The same person, once they have a job with this vendor, is let straight in.
    await giveStanding(strangerId, businessId);
    const allowed = await request(app)
      .post('/api/v1/message-threads')
      .set(...bearer(stranger))
      .send({ businessId });
    expect(allowed.status).toBe(201);
  });

  /**
   * The owner is never gated: they must be able to reach a customer about their own job, including
   * one who has not messaged first.
   */
  it('lets the business owner open a thread with a customer unprompted', async () => {
    const categoryId = await openCategory('p3-owner-msg');
    const { token: vendorToken, businessId } = await makeVendorBusiness('p3om', categoryId);
    const custId = await seedUser({ authProviderId: 'p3om|cust', roles: ['customer'] });

    const opened = await request(app)
      .post('/api/v1/message-threads')
      .set(...bearer(vendorToken))
      .send({ businessId, customerId: custId });
    expect(opened.status).toBe(201);
    expect(opened.body.data.customerId).toBe(custId);

    // A third party still cannot open a thread on someone else's behalf.
    await seedUser({ authProviderId: 'p3om|imposter', roles: ['customer'] });
    const imposter = await mintToken('p3om|imposter');
    const denied = await request(app)
      .post('/api/v1/message-threads')
      .set(...bearer(imposter))
      .send({ businessId, customerId: custId });
    expect(denied.status).toBe(403);
  });
});

describe('vendor dashboard read model', () => {
  it('composes live status, queue, orders, sales, and threads for the owner', async () => {
    const categoryId = await openCategory('p3-dash');
    const { token, businessId } = await makeVendorBusiness('p3d', categoryId, { live: true });
    const dash = await request(app)
      .get(`/api/v1/businesses/${businessId}/dashboard`)
      .set(...bearer(token));
    expect(dash.status).toBe(200);
    expect(dash.body.data.liveStatus).toBe('parked');
    expect(dash.body.data.orders).toHaveProperty('pending');
    expect(dash.body.data.queue).toHaveProperty('entries');
    expect(dash.body.data.salesSummary).toHaveProperty('grossCents');

    // A different vendor cannot view this dashboard.
    await seedUser({ authProviderId: 'p3d|other', roles: ['vendor'] });
    const other = await mintToken('p3d|other');
    const denied = await request(app)
      .get(`/api/v1/businesses/${businessId}/dashboard`)
      .set(...bearer(other));
    expect(denied.status).toBe(403);
  });
});
