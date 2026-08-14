import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { SELLER_AGREEMENT_VERSION } from '../src/config/constants';
import { setStripeGateway } from '../src/integrations/stripe';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import {
  HubModel,
  InventoryCheckoutModel,
  InventoryReturnModel,
  InventorySaleModel,
} from '../src/modules/consignment/consignment.model';
import { currentQrToken, verifyQrToken, QR_WINDOW_SECONDS } from '../src/modules/consignment/hubQr';
import { fraudSignalsService } from '../src/modules/consignment/fraudSignals.service';
import { balanceMonitorService } from '../src/modules/payments/balanceMonitor.service';
import { ledgerService } from '../src/modules/ledger/ledger.service';
import { trustService } from '../src/modules/trust/trust.service';
import { FraudFlagModel } from '../src/shared/fraud';
import { bearer, mintToken, seedUser } from './helpers';
import { FakeStripeGateway } from './fakes';

/**
 * PHASE 6 — HARDENING. Security, correctness and scale fixes for the consignment money path.
 */
const app = createApp();
const fakeStripe = new FakeStripeGateway();

beforeAll(() => setStripeGateway(fakeStripe));

function stripeEvent(type: string, object: Record<string, unknown>) {
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', 'test')
    .set('content-type', 'application/json')
    .send(JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } }));
}

async function enablePayouts(ownerType: 'user' | 'business', ownerId: string) {
  const acct = await ConnectedAccountModel.findOne({
    owner_type: ownerType,
    owner_id: ownerId,
  }).lean();
  fakeStripe.enableAccount(acct!.stripe_account_id);
  await stripeEvent('account.updated', { id: acct!.stripe_account_id });
}

async function makeHub(prefix: string, opts: { unitValue?: number; qty?: number } = {}) {
  const cat = await CategoryModel.create({
    slug: `${prefix}-cat`,
    name: prefix,
    top_level_tab: 'shopping',
    requires_license: false,
  });
  await seedUser({ authProviderId: `${prefix}|hub`, roles: ['vendor', 'hub'] });
  const hubToken = await mintToken(`${prefix}|hub`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(hubToken))
    .send({ name: `${prefix} Hub`, categoryId: String(cat._id), isHub: true });
  const businessId = biz.body.data.id as string;
  await request(app).post(`/api/v1/businesses/${businessId}/payouts/onboard`).set(...bearer(hubToken));
  await enablePayouts('business', businessId);

  const hub = await request(app).post('/api/v1/hubs').set(...bearer(hubToken)).send({ businessId });
  const hubId = hub.body.data.id as string;
  await request(app)
    .patch(`/api/v1/hubs/${hubId}/approval-policy`)
    .set(...bearer(hubToken))
    .send({ autoApproveMinTrust: 0, autoApproveMaxValueCents: null });

  const product = await request(app)
    .post(`/api/v1/hubs/${hubId}/products`)
    .set(...bearer(hubToken))
    .send({
      name: 'Handmade Mug',
      unitValueCents: opts.unitValue ?? 1000,
      consignmentSplitPercent: 65,
      returnWindowHours: 72,
      quantityAvailable: opts.qty ?? 50,
    });

  return {
    hubToken,
    hubId,
    businessId,
    qrToken: hub.body.data.token as string,
    productId: product.body.data.id as string,
  };
}

async function makeSeller(prefix: string, tier: 'bronze' | 'silver' | 'gold' = 'gold') {
  const sellerId = await seedUser({ authProviderId: `${prefix}|seller`, roles: ['seller'], tier });
  const token = await mintToken(`${prefix}|seller`);
  await request(app).post('/api/v1/payments/connect/onboard').set(...bearer(token));
  await enablePayouts('user', sellerId);
  await request(app)
    .post('/api/v1/seller-agreement/accept')
    .set(...bearer(token))
    .send({ version: SELLER_AGREEMENT_VERSION });
  return { sellerId, token };
}

// ─── 1. Rotating QR ───────────────────────────────────────────────────────────────────────────

describe('rotating hub QR token (Phase 6)', () => {
  it('accepts a current token and rejects one from an expired window', () => {
    const secret = 'sekrit';
    const hubId = 'hub_1';
    const { token } = currentQrToken(secret, hubId);

    expect(verifyQrToken(secret, hubId, token)).toBe(true);
    // Still valid one window later (clock skew tolerance)…
    expect(verifyQrToken(secret, hubId, token, Date.now() + QR_WINDOW_SECONDS * 1000)).toBe(true);
    // …but a photographed code is worthless soon after. THIS is the vulnerability being closed.
    expect(verifyQrToken(secret, hubId, token, Date.now() + QR_WINDOW_SECONDS * 4000)).toBe(false);
  });

  it('rejects a token minted for a different hub or with the wrong key', () => {
    const { token } = currentQrToken('sekrit', 'hub_1');
    expect(verifyQrToken('sekrit', 'hub_2', token)).toBe(false); // replay at another hub
    expect(verifyQrToken('other-secret', 'hub_1', token)).toBe(false);
    expect(verifyQrToken('sekrit', 'hub_1', 'garbage')).toBe(false);
    expect(verifyQrToken('sekrit', 'hub_1', 'ssq1.999.zzz')).toBe(false);
  });

  it('no longer hands out the raw signing secret at registration', async () => {
    const h = await makeHub('p6qr');
    const hub = await HubModel.findById(h.hubId).lean();
    // The response carries a rotating token, never the stored key.
    expect(h.qrToken).not.toBe(hub!.checkout_qr_secret);
    expect(h.qrToken.startsWith('ssq1.')).toBe(true);
  });

  it('refuses the raw static secret at checkout for a new hub', async () => {
    const h = await makeHub('p6static');
    const s = await makeSeller('p6static');
    const hub = await HubModel.findById(h.hubId).lean();

    // Exactly the old attack: someone who obtained the stored secret tries to use it directly.
    const res = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(s.token))
      .send({
        productId: h.productId,
        quantity: 1,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: hub!.checkout_qr_secret,
      });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/invalid or expired/i);
  });

  it('still accepts the static secret for a grandfathered hub that printed a poster', async () => {
    const h = await makeHub('p6grand');
    const s = await makeSeller('p6grand');
    // 6.5: an explicit future deadline, rather than relying on the platform sunset — otherwise this
    // test silently starts failing on the sunset date, which is the worst way to learn about it.
    await HubModel.updateOne(
      { _id: h.hubId },
      { $set: { allow_static_qr: true, static_qr_deadline_at: new Date(Date.now() + 86_400_000) } },
    );
    const hub = await HubModel.findById(h.hubId).lean();

    const res = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(s.token))
      .send({
        productId: h.productId,
        quantity: 1,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: hub!.checkout_qr_secret,
      });
    expect(res.status).toBe(201);
  });

  it('refuses the static secret once the hub deadline has passed (6.5)', async () => {
    // The grandfathering was always meant to end. Before 6.5 nothing made it: the flag had no
    // deadline, so "temporary" lasted as long as nobody remembered.
    const h = await makeHub('p6expired');
    const s = await makeSeller('p6expired');
    await HubModel.updateOne(
      { _id: h.hubId },
      { $set: { allow_static_qr: true, static_qr_deadline_at: new Date(Date.now() - 86_400_000) } },
    );
    const hub = await HubModel.findById(h.hubId).lean();

    const res = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(s.token))
      .send({
        productId: h.productId,
        quantity: 1,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: hub!.checkout_qr_secret,
      });
    expect(res.status).toBe(403);
  });

  it('serves the station a fresh token, owner-only', async () => {
    const h = await makeHub('p6station');
    const res = await request(app)
      .get(`/api/v1/hubs/${h.hubId}/qr`)
      .set(...bearer(h.hubToken));
    expect(res.status).toBe(200);
    expect(res.body.data.token.startsWith('ssq1.')).toBe(true);
    expect(res.body.data.rotateSeconds).toBe(QR_WINDOW_SECONDS);
    expect(res.body.data.staticQrStillAccepted).toBe(false);

    // A different hub owner cannot read someone else's station token.
    const other = await makeHub('p6station2');
    const stolen = await request(app)
      .get(`/api/v1/hubs/${h.hubId}/qr`)
      .set(...bearer(other.hubToken));
    expect(stolen.status).toBe(403);
  });
});

// ─── 3. Batched trust lookup ──────────────────────────────────────────────────────────────────

describe('batched trust scores (Phase 6)', () => {
  it('returns a score per subject in one call, defaulting unknown subjects', async () => {
    const a = await seedUser({ authProviderId: 'p6trust|a', roles: ['seller'] });
    const b = await seedUser({ authProviderId: 'p6trust|b', roles: ['seller'] });
    await trustService.recompute('seller', a);

    const scores = await trustService.getScores('seller', [a, b, a]);
    expect(scores.size).toBe(2); // de-duplicated
    expect(scores.get(a)).toBe((await trustService.getScore('seller', a)).score);
    // Never computed → same default as the single-item path.
    expect(scores.get(b)).toBe((await trustService.getScore('seller', b)).score);
  });
});

// ─── 4. Geospatial discovery + pagination ─────────────────────────────────────────────────────

describe('product discovery: distance filter + pagination (Phase 6)', () => {
  it('only returns inventory from hubs within range, and paginates', async () => {
    const near = await makeHub('p6near');
    const far = await makeHub('p6far');
    // Modesto, CA and ~250km away.
    await HubModel.updateOne(
      { _id: near.hubId },
      { $set: { location: { type: 'Point', coordinates: [-120.9969, 37.6391] } } },
    );
    await HubModel.updateOne(
      { _id: far.hubId },
      { $set: { location: { type: 'Point', coordinates: [-118.2437, 34.0522] } } },
    );

    const buyer = await makeSeller('p6geo');

    const nearby = await request(app)
      .get('/api/v1/products/nearby?lng=-120.9969&lat=37.6391&radiusM=20000')
      .set(...bearer(buyer.token));
    expect(nearby.status).toBe(200);
    const hubIds = nearby.body.data.items.map((p: { hubId: string }) => p.hubId);
    expect(hubIds).toContain(near.hubId);
    expect(hubIds).not.toContain(far.hubId); // 250km away is not "nearby"

    // Pagination is real, not a silent 200-row truncation.
    const paged = await request(app)
      .get('/api/v1/products/nearby?limit=1')
      .set(...bearer(buyer.token));
    expect(paged.body.data.items).toHaveLength(1);
    expect(paged.body.data.nextCursor).toBeTruthy();
  });

  it('returns nothing when no hub is in range, rather than falling back to everything', async () => {
    const buyer = await makeSeller('p6geo2');
    // Middle of the Atlantic.
    const res = await request(app)
      .get('/api/v1/products/nearby?lng=-30&lat=0&radiusM=1000')
      .set(...bearer(buyer.token));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(0);
  });

  it('rejects a half-specified coordinate', async () => {
    const buyer = await makeSeller('p6geo3');
    const res = await request(app)
      .get('/api/v1/products/nearby?lng=-120.9')
      .set(...bearer(buyer.token));
    // Schema violations are VALIDATION_ERROR → 400 in this codebase.
    expect(res.status).toBe(400);
  });
});

// ─── 5. Fraud signals ─────────────────────────────────────────────────────────────────────────

describe('consignment fraud signals (Phase 6)', () => {
  it('flags a cash-only sales pattern for HUMAN review', async () => {
    const h = await makeHub('p6fraud', { qty: 200 });
    const s = await makeSeller('p6fraud');
    const checkout = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(s.token))
      .send({
        productId: h.productId,
        quantity: 20,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: h.qrToken,
      });
    const checkoutId = checkout.body.data.id as string;

    // 10 cash sales, no digital — the pattern under-reporting would produce.
    for (let i = 0; i < 10; i++) {
      await InventorySaleModel.create({
        checkout_id: checkoutId,
        quantity_sold: 1,
        sale_amount_cents: 1000,
        payment_rail: 'cash',
      });
    }

    expect(await fraudSignalsService.checkCashRatio(s.sellerId)).toBe(true);
    const flag = await FraudFlagModel.findOne({
      subject_id: s.sellerId,
      type: 'cash_under_reporting',
    }).lean();
    expect(flag).toBeTruthy();
    // Flagged for review — never auto-enforced against the seller.
    expect(flag!.status).toBe('open');
    expect(String(flag!.signals.note)).toMatch(/review, do not auto-act/i);
  });

  it('does not flag a seller with a healthy digital mix', async () => {
    const h = await makeHub('p6clean', { qty: 200 });
    const s = await makeSeller('p6clean');
    const checkout = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(s.token))
      .send({
        productId: h.productId,
        quantity: 20,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: h.qrToken,
      });
    const checkoutId = checkout.body.data.id as string;

    for (let i = 0; i < 10; i++) {
      await InventorySaleModel.create({
        checkout_id: checkoutId,
        quantity_sold: 1,
        sale_amount_cents: 1000,
        payment_rail: i % 2 === 0 ? 'digital' : 'cash',
      });
    }
    expect(await fraudSignalsService.checkCashRatio(s.sellerId)).toBe(false);
  });

  it('flags repeated lost/damaged claims across separate checkouts', async () => {
    const h = await makeHub('p6loss', { qty: 200 });
    const s = await makeSeller('p6loss');
    for (let i = 0; i < 3; i++) {
      const c = await request(app)
        .post('/api/v1/checkouts')
        .set(...bearer(s.token))
        .send({
          productId: h.productId,
          quantity: 2,
          conditionPhotoUrl: 'https://cdn.test/c.jpg',
          qrToken: h.qrToken,
        });
      await InventoryReturnModel.create({
        checkout_id: c.body.data.id,
        quantity_returned: 2,
        condition_assessment: 'lost',
      });
    }

    expect(await fraudSignalsService.checkRepeatLossClaims(s.sellerId)).toBe(true);
    const flag = await FraudFlagModel.findOne({
      subject_id: s.sellerId,
      type: 'repeat_loss_claims',
    }).lean();
    expect(flag).toBeTruthy();
  });

  it('ignores a small sample rather than flagging on noise', async () => {
    const h = await makeHub('p6small', { qty: 50 });
    const s = await makeSeller('p6small');
    const c = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(s.token))
      .send({
        productId: h.productId,
        quantity: 3,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: h.qrToken,
      });
    await InventorySaleModel.create({
      checkout_id: c.body.data.id,
      quantity_sold: 1,
      sale_amount_cents: 1000,
      payment_rail: 'cash',
    });
    // One cash sale is not a pattern.
    expect(await fraudSignalsService.checkCashRatio(s.sellerId)).toBe(false);
  });
});

// ─── 6. Balance monitoring ────────────────────────────────────────────────────────────────────

describe('platform balance monitoring (Phase 6)', () => {
  it('reports healthy when cash covers every obligation', async () => {
    await ledgerService.post({
      transactionId: `p6bal_ok_${Date.now()}`,
      entries: [
        { ownerType: 'platform', accountType: 'cash', direction: 'debit', amountCents: 100_000, entryType: 'sale_capture' },
        { ownerType: 'business', ownerId: 'p6bal_hub', accountType: 'payable', direction: 'credit', amountCents: 100_000, entryType: 'hub_share' },
      ],
    });
    const solvency = await ledgerService.solvency();
    expect(solvency.cashCents).toBeGreaterThanOrEqual(solvency.obligationsCents);
    expect(solvency.healthy).toBe(true);
  });

  it('raises an alert when obligations exceed the cash held', async () => {
    // Pay out more than was collected — exactly the Phase 0 failure, now detectable.
    await ledgerService.post({
      transactionId: `p6bal_bad_${Date.now()}`,
      entries: [
        { ownerType: 'business', ownerId: 'p6bal_hub2', accountType: 'payable', direction: 'credit', amountCents: 500_000, entryType: 'hub_share' },
        { ownerType: 'platform', accountType: 'receivable', direction: 'debit', amountCents: 500_000, entryType: 'cash_receivable' },
      ],
    });
    const result = await balanceMonitorService.check();
    expect(result.solvency.healthy).toBe(false);
    expect(result.alerts.some((a) => a.includes('INSOLVENT'))).toBe(true);
  });

  it('counts collected sales tax as unspendable', async () => {
    await ledgerService.post({
      transactionId: `p6bal_tax_${Date.now()}`,
      entries: [
        { ownerType: 'platform', accountType: 'cash', direction: 'debit', amountCents: 5_000, entryType: 'tax_collected' },
        { ownerType: 'platform', accountType: 'tax_payable', direction: 'credit', amountCents: 5_000, entryType: 'tax_collected' },
      ],
    });
    const result = await balanceMonitorService.check();
    expect(result.solvency.taxPayableCents).toBeGreaterThanOrEqual(5_000);
    expect(result.alerts.some((a) => /awaiting remittance/i.test(a))).toBe(true);
  });
});

// ─── 2. Settlement follow-up off the request path ─────────────────────────────────────────────

describe('settlement follow-up (Phase 6)', () => {
  it('still recomputes trust when no queue is available, rather than dropping it', async () => {
    const h = await makeHub('p6queue', { qty: 20 });
    const s = await makeSeller('p6queue');
    const c = await request(app)
      .post('/api/v1/checkouts')
      .set(...bearer(s.token))
      .send({
        productId: h.productId,
        quantity: 2,
        conditionPhotoUrl: 'https://cdn.test/c.jpg',
        qrToken: h.qrToken,
      });
    await request(app)
      .post(`/api/v1/checkouts/${c.body.data.id}/sales`)
      .set(...bearer(s.token))
      .send({ quantitySold: 2, saleAmountCents: 2000, paymentRail: 'cash' });

    // No Redis in tests → the inline fallback must have run, leaving a real score behind.
    const score = await trustService.getScore('seller', s.sellerId);
    expect(score.computedAt).not.toBeNull();
    const settled = await InventoryCheckoutModel.findById(c.body.data.id).lean();
    expect(settled!.status).toBe('settled');
  });
});
