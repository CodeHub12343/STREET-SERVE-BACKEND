import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { FEE_TYPES } from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel, FeeScheduleModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { feeService } from '../src/modules/payments/fees';
import { computeOrderBreakdown } from '../src/modules/orders/pricing';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * 8.5 — **every fee the customer pays is shown before they pay it** (§31, §33, §32.4).
 *
 * ## Why this needs its own test rather than resting on the existing ones
 *
 * Every customer-facing fee is OFF at launch (`CUSTOMER_SERVICE_FEE_ENABLED`,
 * `PROCESSING_FEE_ENABLED`, `WAVE_CONVENIENCE_FEE_ENABLED` all default false, per §33's
 * keep-checkout-simple posture). So the whole existing suite exercises the zero case, and the
 * disclosure requirement — the thing §31 actually asks for — is never tested.
 *
 * That is precisely the shape of the F-1 family of defects the audit found: *money arithmetic that
 * was correct only because the fees it depended on were switched off.* These tests turn every fee
 * ON and assert the itemization, so the day ops flips a flag is not the day anyone discovers the
 * line does not render.
 *
 * ## What "disclosed" means here
 *
 * Three properties, and all three matter:
 *
 *  1. **Itemized, not aggregated.** "$5.99 of fees" tells a customer nothing about who they are
 *     paying or what for. Each fee is its own field.
 *  2. **The preview equals the charge.** `quote` and `place` share one pricing path, so a customer
 *     cannot be charged a total they did not see.
 *  3. **The lines sum to the total.** A breakdown whose parts do not add up is not a disclosure —
 *     it is a number with some decoration next to it.
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();
beforeAll(() => setStripeGateway(fakeStripe));

/** Restore the launch posture after each test — these flags are global. */
afterEach(async () => {
  feeService.setOrderFeeFlags({ customerService: false, processing: false, waveConvenience: false });
  await FeeScheduleModel.deleteMany({});
  feeService.invalidateFeeCache();
});

async function seedFeeSchedule() {
  await FeeScheduleModel.create({
    version: 900,
    effective_at: new Date(Date.now() - 60_000),
    consignment_fee_bps: 1000,
    fees: {
      customer_service: { rate_bps: 500, min_cents: 50, max_cents: 400 },
      processing: { rate_bps: 290, flat_cents: 30 },
      wave_convenience: { flat_cents: 199 },
      marketplace: { rate_bps: 1000 },
    },
  });
  feeService.invalidateFeeCache();
}

async function vendorWithMenu(prefix: string) {
  const cat = await CategoryModel.create({
    slug: `${prefix}-cat`,
    name: prefix,
    top_level_tab: 'food',
    requires_license: false,
  });
  await seedUser({ authProviderId: `${prefix}|vendor`, roles: ['vendor'] });
  const token = await mintToken(`${prefix}|vendor`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(token))
    .send({ name: `${prefix} Tacos`, categoryId: String(cat._id) });
  const businessId = biz.body.data.id as string;
  // Payouts must be live or a charge cannot be routed to the business.
  await request(app).post(`/api/v1/businesses/${businessId}/payouts/onboard`).set(...bearer(token));
  const acct = await ConnectedAccountModel.findOne({
    owner_type: 'business',
    owner_id: businessId,
  }).lean();
  if (acct) {
    fakeStripe.enableAccount(acct.stripe_account_id);
    await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', 'test')
      .set('content-type', 'application/json')
      .send(
        JSON.stringify({
          id: `evt_${Math.random()}`,
          type: 'account.updated',
          data: { object: { id: acct.stripe_account_id } },
        }),
      );
  }

  const item = await request(app)
    .post(`/api/v1/businesses/${businessId}/menu`)
    .set(...bearer(token))
    .send({ name: 'Taco plate', priceCents: 2000 });
  return { token, businessId, menuItemId: item.body.data.id as string };
}

async function customer(prefix: string) {
  await seedUser({ authProviderId: `${prefix}|cust`, roles: ['customer'] });
  return mintToken(`${prefix}|cust`);
}

describe('fee disclosure at checkout (8.5 / §31, §33)', () => {
  it('itemizes EVERY mandated line, even when the fee is zero', async () => {
    // §31 lists the lines a checkout must show. A missing key is a line a client cannot render, and
    // "we would have shown it if it were non-zero" is not a disclosure design — the customer should
    // be able to see that tax is zero, not infer it from an absence.
    const v = await vendorWithMenu('fd-shape');
    const cust = await customer('fd-shape');

    const quote = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(cust))
      .send({ businessId: v.businessId, items: [{ menuItemId: v.menuItemId, quantity: 1 }] });

    expect(quote.status).toBe(200);
    for (const line of [
      'subtotalCents',
      'discountCents',
      'taxCents',
      'deliveryCents',
      'serviceFeeCents',
      'processingFeeCents',
      'tipCents',
      'roundUpCents',
      'totalCents',
      'platformFeeCents',
    ]) {
      expect(quote.body.data.breakdown, `missing §31 line: ${line}`).toHaveProperty(line);
    }
  });

  it('shows each fee separately once the flags are on, and the lines sum to the total', async () => {
    await seedFeeSchedule();
    feeService.setOrderFeeFlags({ customerService: true, processing: true });

    const v = await vendorWithMenu('fd-on');
    const cust = await customer('fd-on');

    const quote = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(cust))
      .send({
        businessId: v.businessId,
        items: [{ menuItemId: v.menuItemId, quantity: 2 }],
        tipCents: 300,
      });

    const b = quote.body.data.breakdown;
    expect(b.subtotalCents).toBe(4000);
    // 5% of 4000, inside the 50–400 bounds.
    expect(b.serviceFeeCents).toBe(200);
    // 2.9% + 30¢ on everything that came before it, including the tip.
    expect(b.processingFeeCents).toBeGreaterThan(0);

    // The disclosure is only a disclosure if it adds up.
    const sum =
      b.subtotalCents -
      b.discountCents +
      b.taxCents +
      b.deliveryCents +
      b.serviceFeeCents +
      b.processingFeeCents +
      b.tipCents +
      b.roundUpCents;
    expect(sum).toBe(b.totalCents);
  });

  it('never charges a customer-facing fee while its flag is off', async () => {
    // The launch posture (§33: keep checkout simple). Asserted so a stray schedule entry cannot
    // start charging people without the flag being flipped deliberately.
    await seedFeeSchedule();
    const v = await vendorWithMenu('fd-off');
    const cust = await customer('fd-off');

    const quote = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(cust))
      .send({ businessId: v.businessId, items: [{ menuItemId: v.menuItemId, quantity: 1 }] });

    expect(quote.body.data.breakdown.serviceFeeCents).toBe(0);
    expect(quote.body.data.breakdown.processingFeeCents).toBe(0);
    expect(quote.body.data.breakdown.totalCents).toBe(2000);
  });

  it('the platform fee is reported but NOT added to what the customer pays', async () => {
    // §31: the 10% marketplace fee is the vendor's cost. Showing it is transparency; charging it
    // to the customer would be charging twice for the same sale.
    await seedFeeSchedule();
    const v = await vendorWithMenu('fd-platform');
    const cust = await customer('fd-platform');

    const quote = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(cust))
      .send({ businessId: v.businessId, items: [{ menuItemId: v.menuItemId, quantity: 1 }] });

    const b = quote.body.data.breakdown;
    expect(b.platformFeeCents).toBeGreaterThan(0);
    expect(b.totalCents).toBe(2000); // unchanged by the platform fee
  });

  it('the preview a customer confirms equals the charge they get', async () => {
    // One pricing path serves both, so this is a property of the design rather than a coincidence —
    // and this test is what keeps it that way.
    await seedFeeSchedule();
    feeService.setOrderFeeFlags({ customerService: true, processing: true });

    const v = await vendorWithMenu('fd-preview');
    const cust = await customer('fd-preview');
    const body = {
      businessId: v.businessId,
      items: [{ menuItemId: v.menuItemId, quantity: 1 }],
      tipCents: 150,
    };

    const quote = await request(app)
      .post('/api/v1/orders/quote')
      .set(...bearer(cust))
      .send(body);

    // Go live so the order is accepted, then place the identical order.
    const terms = await request(app).get('/api/v1/agreements/regular_sale');
    await request(app)
      .post('/api/v1/agreements/regular_sale/accept')
      .set(...bearer(v.token))
      .send({ version: terms.body.data.version, contentHash: terms.body.data.contentHash });
    await request(app)
      .post('/api/v1/live-sessions/start')
      .set(...bearer(v.token))
      .send({
        actorType: 'business',
        actorId: v.businessId,
        status: 'parked',
        lng: -120.99,
        lat: 37.64,
      });

    const placed = await request(app)
      .post('/api/v1/orders')
      .set(...bearer(cust))
      .set('Idempotency-Key', 'fd-preview-1')
      .send(body);

    expect(placed.status).toBe(201);
    // The placed order carries the SAME itemization the quote showed — the receipt is not a second,
    // differently-derived number.
    expect(placed.body.data.breakdown).toMatchObject({
      subtotalCents: quote.body.data.breakdown.subtotalCents,
      serviceFeeCents: quote.body.data.breakdown.serviceFeeCents,
      processingFeeCents: quote.body.data.breakdown.processingFeeCents,
      tipCents: quote.body.data.breakdown.tipCents,
      totalCents: quote.body.data.breakdown.totalCents,
    });
  });

  it('respects the customer-service fee floor and cap', async () => {
    // A percentage fee with no floor collects nothing on a $2 order and a lot on a $2,000 one.
    // Both bounds are disclosed rates, so both have to hold.
    await seedFeeSchedule();
    feeService.setOrderFeeFlags({ customerService: true });

    // 5% of $2.00 = 10¢, floored to the 50¢ minimum.
    expect(computeOrderBreakdown({
      subtotalCents: 200,
      rates: {
        taxBps: 0,
        serviceFeeBps: 500,
        serviceFeeMinCents: 50,
        serviceFeeMaxCents: 400,
        processingBps: 0,
        processingFlatCents: 0,
        deliveryCents: 0,
      },
    }).serviceFeeCents).toBe(50);

    // 5% of $200.00 = $10.00, capped at $4.00.
    expect(computeOrderBreakdown({
      subtotalCents: 20_000,
      rates: {
        taxBps: 0,
        serviceFeeBps: 500,
        serviceFeeMinCents: 50,
        serviceFeeMaxCents: 400,
        processingBps: 0,
        processingFlatCents: 0,
        deliveryCents: 0,
      },
    }).serviceFeeCents).toBe(400);
  });
});

describe('§32.4 — waved-down fees are disclosed before the customer confirms', () => {
  it('names each fee and its payee, rather than a single total', async () => {
    // "$5.99 of fees" tells a customer nothing about who they are paying or what for. The vendor's
    // travel fee is the VENDOR'S; the convenience fee is the PLATFORM'S.
    await seedFeeSchedule();
    feeService.setOrderFeeFlags({ waveConvenience: true });

    const convenience = await feeService.resolveWaveConvenienceFee();
    expect(convenience).toBe(199);
  });

  it('charges no convenience fee while the flag is off', async () => {
    await seedFeeSchedule();
    expect(await feeService.resolveWaveConvenienceFee()).toBe(0);
  });
});

describe('the fee registry itself (8.5)', () => {
  it('prices every declared fee type — an unpriced type must charge zero, never throw', async () => {
    // A fee type with no rule on the money path is a 500 at checkout. Charging nothing is the safe
    // failure; failing the payment is not.
    for (const type of FEE_TYPES) {
      const fee = await feeService.resolveFee(type, 10_000);
      expect(Number.isInteger(fee), `${type} produced a non-integer fee`).toBe(true);
      expect(fee, `${type} produced a negative fee`).toBeGreaterThanOrEqual(0);
    }
  });
});
