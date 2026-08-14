import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  POSTCARD_ACCESS_MODE,
  POSTCARD_PILOT_MAX_ORDER_CENTS,
} from '../src/config/constants';
import {
  createFakePrintVendor,
  resetPrintVendor,
  setPrintVendor,
  type FakePrintVendor,
} from '../src/integrations/print';
import {
  PostcardPilotParticipantModel,
  pilotService,
} from '../src/modules/postcards/pilot.service';
import { pilotReviewService } from '../src/modules/postcards/pilotReview.service';
import {
  PostcardAssetModel,
  PostcardOrderModel,
  PostcardPayableModel,
} from '../src/modules/postcards/postcards.model';
import type { Principal } from '../src/shared/types/principal';

/**
 * Phase 8 — the pilot gate and its review.
 *
 * This feature is the first on the platform that produces something irreversible, paid for with
 * real money, through a vendor nobody has run a live order against. So the properties worth
 * defending are about blast radius and about honesty:
 *
 *  • a business nobody chose cannot start ordering;
 *  • a business cannot let ITSELF in — that is the whole difference between a pilot and a module;
 *  • an order above the pilot ceiling is refused rather than charged;
 *  • the review reports what it measured and says "unknown" for what it did not, because the one
 *    thing the pilot exists to establish is the unit economics, and a number that quietly defaults
 *    to zero would leave the assumption in place while looking like evidence.
 */

const ADMIN: Principal = { userId: 'admin1', roles: ['admin'] } as Principal;
let vendor: FakePrintVendor;

beforeEach(async () => {
  await Promise.all([
    PostcardPilotParticipantModel.deleteMany({}),
    PostcardOrderModel.deleteMany({}),
    PostcardAssetModel.deleteMany({}),
    PostcardPayableModel.deleteMany({}),
  ]);
  vendor = createFakePrintVendor();
  setPrintVendor(vendor);
});
afterEach(() => {
  resetPrintVendor();
  vi.restoreAllMocks();
});

describe('the pilot gate', () => {
  it('starts in pilot mode, because the blast radius is paper in mailboxes', () => {
    // If this ever defaults to `general`, the next deploy opens an irreversible, real-money feature
    // to everyone at once. The default is the safeguard.
    expect(POSTCARD_ACCESS_MODE).toBe('pilot');
  });

  it('refuses a business nobody added', async () => {
    await expect(pilotService.assertMayOrder('biz-unknown')).rejects.toThrow(/limited pilot/i);
  });

  it('admits a business ops added, and records who and why', async () => {
    await pilotService.add(ADMIN, 'biz1', 'Taco truck on 9th — agreed to be first');

    await expect(pilotService.assertMayOrder('biz1')).resolves.toBeUndefined();

    const roster = await pilotService.list();
    expect(roster.activeCount).toBe(1);
    // A roster nobody can explain is not a roster.
    expect(roster.participants[0]).toMatchObject({
      businessId: 'biz1',
      active: true,
      addedBy: 'admin1',
      note: 'Taco truck on 9th — agreed to be first',
    });
  });

  it('shuts the door again on removal, and keeps the record', async () => {
    await pilotService.add(ADMIN, 'biz1');
    await pilotService.remove(ADMIN, 'biz1', 'Pausing while they change their menu');

    await expect(pilotService.assertMayOrder('biz1')).rejects.toThrow();

    // Soft-removed, not deleted: the review still needs to see they took part.
    const roster = await pilotService.list();
    expect(roster.participants).toHaveLength(1);
    expect(roster.participants[0]).toMatchObject({
      active: false,
      removedReason: 'Pausing while they change their menu',
    });
  });

  it('will not let someone be removed without a reason', async () => {
    await pilotService.add(ADMIN, 'biz1');
    await expect(pilotService.remove(ADMIN, 'biz1', '   ')).rejects.toThrow(/reason/i);
  });

  it('re-admitting clears the removal rather than stacking rows', async () => {
    await pilotService.add(ADMIN, 'biz1');
    await pilotService.remove(ADMIN, 'biz1', 'paused');
    await pilotService.add(ADMIN, 'biz1', 'back in');

    const roster = await pilotService.list();
    expect(roster.participants).toHaveLength(1);
    expect(roster.participants[0]).toMatchObject({ active: true, removedReason: null });
  });
});

describe('the pilot spend ceiling', () => {
  it('refuses an order above the cap instead of charging it', () => {
    // A guard against OUR arithmetic: quantity comes from a vendor count we do not compute, and a
    // bug there is a five-figure charge on a real card.
    expect(() => pilotService.assertWithinPilotCap(POSTCARD_PILOT_MAX_ORDER_CENTS + 1)).toThrow(
      /capped at/i,
    );
  });

  it('allows an order at the cap', () => {
    expect(() => pilotService.assertWithinPilotCap(POSTCARD_PILOT_MAX_ORDER_CENTS)).not.toThrow();
  });
});

describe('the pilot review (8.2)', () => {
  /** A paid order, optionally with a settled vendor payable at a real (possibly different) cost. */
  async function seedPaidOrder(opts: {
    chargedCents: number;
    quotedVendorCents: number;
    marginCents: number;
    settledVendorCents?: number;
  }): Promise<string> {
    const order = await PostcardOrderModel.create({
      business_id: 'biz1',
      created_by: 'u1',
      sku: '68',
      mail_class: 'standard',
      quantity: 1_000,
      status: 'paid',
      paid_at: new Date(),
      charged_cents: opts.chargedCents,
      vendor_cost_cents: opts.quotedVendorCents,
      margin_cents: opts.marginCents,
      total_cents: opts.chargedCents,
    });

    if (opts.settledVendorCents !== undefined) {
      await PostcardPayableModel.create({
        order_id: String(order._id),
        business_id: 'biz1',
        amount_cents: opts.settledVendorCents,
        status: 'settled',
        accrued_at: new Date(),
      });
    }
    return String(order._id);
  }

  it('reports the cost variance as UNKNOWN until a payable settles', async () => {
    // The central honesty rule. Before settlement the "actual" cost is still our own estimate, so
    // comparing it to our quote would be comparing an assumption to itself and calling it proof.
    await seedPaidOrder({ chargedCents: 50_000, quotedVendorCents: 45_000, marginCents: 5_000 });

    const review = await pilotReviewService.build();

    expect(review.economics.costVarianceCents).toBeNull();
    expect(review.economics.costVariancePercent).toBeNull();
    expect(review.economics.marginRealisedCents).toBeNull();
    expect(review.readiness.join(' ')).toMatch(/no vendor payable has settled/i);
  });

  it('computes the real variance and realised margin once a payable settles', async () => {
    // Quoted $450 of printing, actually billed $495 — the exact discovery the pilot exists for.
    await seedPaidOrder({
      chargedCents: 50_000,
      quotedVendorCents: 45_000,
      marginCents: 5_000,
      settledVendorCents: 49_500,
    });

    const review = await pilotReviewService.build();

    expect(review.economics.settledOrderCount).toBe(1);
    expect(review.economics.costVarianceCents).toBe(4_500);
    expect(review.economics.costVariancePercent).toBe(10);
    // Charged $500, really cost $495 → $5 left, not the $50 we thought.
    expect(review.economics.marginRealisedCents).toBe(500);
    expect(review.readiness.join(' ')).toMatch(/billed MORE than quoted by 10%/i);
  });

  it('ignores unsettled payables when computing "actual" cost', async () => {
    await seedPaidOrder({ chargedCents: 50_000, quotedVendorCents: 45_000, marginCents: 5_000 });
    const order = await PostcardOrderModel.findOne({}).lean();
    await PostcardPayableModel.create({
      order_id: String(order!._id),
      business_id: 'biz1',
      amount_cents: 45_000,
      status: 'accrued', // still OUR figure, not the vendor's
      accrued_at: new Date(),
    });

    const review = await pilotReviewService.build();
    expect(review.economics.settledOrderCount).toBe(0);
    expect(review.economics.costVarianceCents).toBeNull();
  });

  it('measures how long artwork waited for a human', async () => {
    const created = new Date(Date.now() - 3 * 60 * 60_000);
    const asset = await PostcardAssetModel.create({
      business_id: 'biz1',
      created_by: 'u1',
      storage_key: 'k1',
      declared_content_type: 'application/pdf',
      prepress_status: 'passed',
      moderation_status: 'approved',
      moderated_at: new Date(),
    });
    await PostcardAssetModel.collection.updateOne(
      { _id: asset._id },
      { $set: { created_at: created } },
    );

    const review = await pilotReviewService.build();
    expect(review.moderation.reviewed).toBe(1);
    // ~180 minutes; allow a minute of slack for clock drift during the test.
    expect(review.moderation.medianMinutes).toBeGreaterThanOrEqual(179);
  });

  it('counts artwork rejected AFTER payment — the failure that costs a refund', async () => {
    const asset = await PostcardAssetModel.create({
      business_id: 'biz1',
      created_by: 'u1',
      storage_key: 'k2',
      declared_content_type: 'application/pdf',
      prepress_status: 'passed',
      moderation_status: 'rejected',
      moderation_reason: 'Uses a trademark they do not own',
      moderated_at: new Date(),
    });
    await PostcardOrderModel.create({
      business_id: 'biz1',
      created_by: 'u1',
      sku: '68',
      mail_class: 'standard',
      status: 'submission_failed',
      paid_at: new Date(),
      charged_cents: 50_000,
      asset_id: String(asset._id),
    });

    const review = await pilotReviewService.build();
    expect(review.failures.rejectedAfterPayment).toBe(1);
    expect(review.failures.submissionFailed).toBe(1);
    expect(review.readiness.join(' ')).toMatch(/rejected after payment/i);
  });

  it('refuses to look ready when nothing has actually been mailed', async () => {
    await seedPaidOrder({ chargedCents: 10_000, quotedVendorCents: 9_000, marginCents: 1_000 });

    const review = await pilotReviewService.build();

    expect(review.orders.mailed).toBe(0);
    expect(review.readiness.join(' ')).toMatch(/nothing about fulfilment has been proven/i);
    // And it says the sample is too small to conclude from.
    expect(review.readiness.join(' ')).toMatch(/roadmap asks for 5–10/i);
  });
});
