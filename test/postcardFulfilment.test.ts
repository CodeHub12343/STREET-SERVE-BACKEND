import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';

import { POSTCARD_SUBMISSION_MAX_ATTEMPTS } from '../src/config/constants';
import {
  createFakePrintVendor,
  resetPrintVendor,
  setPrintVendor,
  type FakePrintVendor,
} from '../src/integrations/print';
import {
  assertAdvance,
  canAdvance,
  describeStage,
  FULFILMENT_PIPELINE,
  isFulfilmentStage,
  isProgress,
} from '../src/modules/fulfilment/fulfilment';
import { postcardFulfilment } from '../src/modules/postcards/fulfilment.service';
import {
  PostcardAssetModel,
  PostcardAudienceModel,
  PostcardOrderModel,
} from '../src/modules/postcards/postcards.model';
import { CategoryModel } from '../src/modules/catalog/catalog.model';
import { bearer, mintToken, seedUser } from './helpers';

const app = createApp();

/**
 * Phase 6 — getting a paid order to the printer and reporting back.
 *
 * The properties worth defending here are all about money that has already changed hands:
 *
 *  • a paid order ALWAYS reaches the printer, or somebody is told loudly that it did not;
 *  • it reaches the printer exactly ONCE, even under retry;
 *  • nothing unreviewed is ever printed;
 *  • the pipeline never runs backwards, so a buyer is never told their mailing was un-sent.
 */

let vendor: FakePrintVendor;

beforeEach(async () => {
  /**
   * The sweep is global by design — it looks for *any* paid order — so tests have to start from an
   * empty table. Without this, a later test's `submitDue()` picks up an earlier test's leftover
   * order (oldest first) against a vendor instance that no longer knows its list count.
   */
  await Promise.all([
    PostcardOrderModel.deleteMany({}),
    PostcardAssetModel.deleteMany({}),
    PostcardAudienceModel.deleteMany({}),
  ]);
  vendor = createFakePrintVendor();
  setPrintVendor(vendor);
});
afterEach(() => {
  resetPrintVendor();
  vi.restoreAllMocks();
});

let seq = 0;

/** A paid order with approved artwork and a resolved audience — the state the sweep acts on. */
async function seedPaidOrder(
  over: { moderation?: 'pending' | 'approved' | 'rejected' } = {},
): Promise<string> {
  const prefix = `pcf${++seq}-${Date.now()}`;
  const cat = await CategoryModel.create({
    slug: `${prefix}-cat`,
    name: prefix,
    top_level_tab: 'food',
    requires_license: false,
  });
  const userId = await seedUser({ authProviderId: `${prefix}|vendor`, roles: ['vendor'] });
  const token = await mintToken(`${prefix}|vendor`);
  const biz = await request(app)
    .post('/api/v1/businesses')
    .set(...bearer(token))
    .send({ name: `${prefix} Tacos`, categoryId: String(cat._id) });
  const businessId = biz.body.data.id as string;

  const count = await vendor.createAudienceCount({
    type: 'zip',
    keys: ['95350'],
    listType: 'IRL',
  });
  const audience = await PostcardAudienceModel.create({
    business_id: businessId,
    created_by: userId,
    selection_type: 'zip',
    selection_keys: ['95350'],
    list_type: 'IRL',
    list_count_id: count.listCountId,
    record_count: count.recordCount,
    resolved_at: new Date(),
  });

  const asset = await PostcardAssetModel.create({
    business_id: businessId,
    created_by: userId,
    storage_key: `postcard_artwork/${prefix}`,
    declared_content_type: 'application/pdf',
    prepress_status: 'passed',
    validated_sku: '68',
    moderation_status: over.moderation ?? 'approved',
  });

  const order = await PostcardOrderModel.create({
    business_id: businessId,
    created_by: userId,
    sku: '68',
    mail_class: 'standard',
    audience_id: String(audience._id),
    asset_id: String(asset._id),
    quantity: count.recordCount,
    status: 'paid',
    paid_at: new Date(),
    charged_cents: 50_000,
  });
  return String(order._id);
}

describe('fulfilment pipeline — the shared state machine (TD-6)', () => {
  it('stops at mailed and never exposes delivered', () => {
    // A status the platform cannot observe is a promise it cannot keep. The vendor reports
    // `Delivered` meaning a last-facility scan, which is not arrival — so the pipeline ends here.
    expect(FULFILMENT_PIPELINE).toEqual(['preparing', 'printing', 'mailed']);
    expect(isFulfilmentStage('delivered')).toBe(false);
  });

  it('moves forward or stays level, never backwards', () => {
    expect(canAdvance(null, 'mailed')).toBe(true);
    expect(canAdvance('preparing', 'printing')).toBe(true);
    expect(canAdvance('printing', 'printing')).toBe(true); // a replayed report is a no-op
    expect(canAdvance('mailed', 'printing')).toBe(false);
    expect(() => assertAdvance('mailed', 'preparing')).toThrow();
  });

  it('distinguishes real progress from a repeat, so notifications do not double-fire', () => {
    expect(isProgress('preparing', 'printing')).toBe(true);
    expect(isProgress('printing', 'printing')).toBe(false);
  });

  it('describes `mailed` honestly, without promising delivery', () => {
    const copy = describeStage('mailed');
    expect(copy.description).toMatch(/postal service/i);
    expect(copy.description).not.toMatch(/\bdelivered\b/i);
  });
});

describe('submission sweep', () => {
  it('submits a paid, approved order and records the vendor identifiers', async () => {
    const orderId = await seedPaidOrder();

    const result = await postcardFulfilment.submitDue();
    expect(result.submitted).toBe(1);

    const order = await PostcardOrderModel.findById(orderId).lean();
    expect(order?.status).toBe('submitted');
    expect(order?.vendor_order_id).toMatch(/^ord_/);
    expect(order?.fulfilment_stage).toBe('preparing');
    expect(order?.submitted_at).toBeTruthy();
  });

  it('never submits artwork a human has not approved', async () => {
    // The gate that matters most in this file: nothing unreviewed reaches a press (F-7).
    const orderId = await seedPaidOrder({ moderation: 'pending' });

    const result = await postcardFulfilment.submitDue();
    expect(result.blocked).toBe(1);
    expect(result.submitted).toBe(0);

    const order = await PostcardOrderModel.findById(orderId).lean();
    expect(order?.status).toBe('paid');
    expect(vendor.orders.size).toBe(0);
    // Waiting on a reviewer must not burn a retry attempt, or a slow queue would fail the order.
    expect(order?.submission_attempts).toBe(0);
  });

  it('fails immediately, without retries, when artwork was rejected after payment', async () => {
    const orderId = await seedPaidOrder({ moderation: 'rejected' });

    await postcardFulfilment.submitDue();

    const order = await PostcardOrderModel.findById(orderId).lean();
    // No amount of waiting fixes a rejection, so it goes straight to the failed state for a refund.
    expect(order?.status).toBe('submission_failed');
    expect(order?.submission_last_error).toMatch(/refund/i);
    expect(vendor.orders.size).toBe(0);
  });

  it('submits exactly once when the sweep runs repeatedly', async () => {
    // The property that protects real money: a second sweep must not print a second run.
    await seedPaidOrder();

    await postcardFulfilment.submitDue();
    await postcardFulfilment.submitDue();
    await postcardFulfilment.submitDue();

    expect(vendor.orders.size).toBe(1);
  });

  it('treats a duplicate-reference rejection as success, not failure', async () => {
    // Means an earlier attempt reached the printer and we missed the response. Marking it failed
    // would hide a live print run; retrying harder would only produce more 409s.
    const orderId = await seedPaidOrder();
    vi.spyOn(vendor, 'submitOrder').mockRejectedValueOnce(
      Object.assign(new Error('This print order has already been submitted'), { code: 'CONFLICT' }),
    );

    await postcardFulfilment.submitDue();

    const order = await PostcardOrderModel.findById(orderId).lean();
    expect(order?.status).toBe('submitted');
  });

  it('retries a transient failure, then gives up loudly and marks the order failed', async () => {
    const orderId = await seedPaidOrder();
    vi.spyOn(vendor, 'submitOrder').mockRejectedValue(new Error('vendor unreachable'));

    for (let i = 0; i < POSTCARD_SUBMISSION_MAX_ATTEMPTS + 1; i++) {
      // Clear the backoff so the sweep is willing to try again immediately.
      await PostcardOrderModel.updateOne(
        { _id: orderId },
        { $set: { submission_next_attempt_at: null } },
      );
      await postcardFulfilment.submitDue();
    }

    const order = await PostcardOrderModel.findById(orderId).lean();
    // A paid order with no mailing must be VISIBLE, never sitting in `paid` looking healthy (F-5).
    expect(order?.status).toBe('submission_failed');
    expect(order?.submission_last_error).toMatch(/unreachable/i);
  });

  it('backs off between attempts rather than hammering the vendor', async () => {
    const orderId = await seedPaidOrder();
    vi.spyOn(vendor, 'submitOrder').mockRejectedValue(new Error('boom'));

    await postcardFulfilment.submitDue();
    const first = await PostcardOrderModel.findById(orderId).lean();
    expect(first?.submission_next_attempt_at).toBeTruthy();

    // Still inside the backoff: the sweep must pass over it.
    const second = await postcardFulfilment.submitDue();
    expect(second.failed).toBe(0);
    expect(second.submitted).toBe(0);
  });
});

describe('status polling', () => {
  it('advances the stage as the vendor reports progress', async () => {
    const orderId = await seedPaidOrder();
    await postcardFulfilment.submitDue();
    const submitted = await PostcardOrderModel.findById(orderId).lean();
    const vendorOrderId = submitted!.vendor_order_id!;

    vendor.advance(vendorOrderId, 'printing');
    await postcardFulfilment.pollDue();
    expect((await PostcardOrderModel.findById(orderId).lean())?.fulfilment_stage).toBe('printing');

    vendor.advance(vendorOrderId, 'mailed');
    await postcardFulfilment.pollDue();
    expect((await PostcardOrderModel.findById(orderId).lean())?.fulfilment_stage).toBe('mailed');
  });

  it('ignores a backwards report rather than un-mailing an order', async () => {
    const orderId = await seedPaidOrder();
    await postcardFulfilment.submitDue();
    await PostcardOrderModel.updateOne({ _id: orderId }, { $set: { fulfilment_stage: 'mailed' } });

    const applied = await postcardFulfilment.applyStage(orderId, 'preparing');

    expect(applied).toBe(false);
    expect((await PostcardOrderModel.findById(orderId).lean())?.fulfilment_stage).toBe('mailed');
  });

  it('does not write a terminal vendor state into the buyer-facing pipeline', async () => {
    // `canceled` / `payment_hold` are not progress. Putting them in the timeline would show the
    // buyer a word that means the opposite of what a stage means.
    const orderId = await seedPaidOrder();
    await postcardFulfilment.submitDue();

    const applied = await postcardFulfilment.applyStage(orderId, 'payment_hold');

    expect(applied).toBe(false);
    expect((await PostcardOrderModel.findById(orderId).lean())?.fulfilment_stage).toBe('preparing');
  });

  it('stops polling once an order is mailed', async () => {
    const orderId = await seedPaidOrder();
    await postcardFulfilment.submitDue();
    await PostcardOrderModel.updateOne({ _id: orderId }, { $set: { fulfilment_stage: 'mailed' } });

    const result = await postcardFulfilment.pollDue();
    expect(result.polled).toBe(0);
  });
});

describe('vendor callback', () => {
  it('re-fetches authoritative status rather than trusting the payload', async () => {
    const orderId = await seedPaidOrder();
    await postcardFulfilment.submitDue();
    const vendorOrderId = (await PostcardOrderModel.findById(orderId).lean())!.vendor_order_id!;

    // The vendor's real state says `printing`; the callback carries nothing we believe.
    vendor.advance(vendorOrderId, 'printing');
    const result = await postcardFulfilment.onVendorEvent(vendorOrderId);

    expect(result.handled).toBe(true);
    expect((await PostcardOrderModel.findById(orderId).lean())?.fulfilment_stage).toBe('printing');
  });

  it('ignores a callback for an order it does not own', async () => {
    // The reason a forged callback is harmless: an unknown id resolves to nothing.
    const result = await postcardFulfilment.onVendorEvent('ord_not_ours');
    expect(result.handled).toBe(false);
  });
});
