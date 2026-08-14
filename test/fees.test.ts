import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setStripeGateway } from '../src/integrations/stripe';
import { FeeScheduleModel } from '../src/modules/catalog/catalog.model';
import { TransactionModel } from '../src/modules/payments/payments.model';
import { computeFee, feeService, resolveFee } from '../src/modules/payments/fees';
import { paymentsService } from '../src/modules/payments/payments.service';
import { computeOrderBreakdown } from '../src/modules/orders/pricing';
import { FakeStripeGateway } from './fakes';
import { seedUser } from './helpers';

/**
 * Fee-type registry (DEBT1 / PHASE_1_IMPLEMENTATION_PLAN.md §2): fees resolve server-side from the
 * versioned `fee_schedule.fees` map by fee-TYPE, so adding/pricing a type is config, not code.
 * Backward-compat: marketplace/consignment stay at 10%.
 */
const fakeStripe = new FakeStripeGateway();
beforeAll(() => setStripeGateway(fakeStripe));

// Restore the pristine "no schedule → 10% fallback" state so later test files are unaffected.
afterAll(async () => {
  await FeeScheduleModel.deleteMany({});
  feeService.invalidateFeeCache();
});

describe('computeFee (pure math)', () => {
  it('is flat + rate·base, floored at min, capped at max, never negative', () => {
    expect(computeFee({ rate_bps: 1000 }, 1000)).toBe(100); // 10%
    expect(computeFee({ flat_cents: 50, rate_bps: 300 }, 1000)).toBe(80); // 50 + 30
    expect(computeFee({ rate_bps: 300, min_cents: 50 }, 1000)).toBe(50); // 30 floored to min 50
    expect(computeFee({ rate_bps: 1000, max_cents: 60 }, 1000)).toBe(60); // 100 capped to 60
    expect(computeFee({ rate_bps: 0 }, 1000)).toBe(0);
  });
});

describe('resolveFee — config-driven', () => {
  it('with no schedule: marketplace/consignment fall back to 10%, unpriced types to 0', async () => {
    await FeeScheduleModel.deleteMany({});
    feeService.invalidateFeeCache();

    expect(await resolveFee('marketplace', 1000)).toBe(100);
    expect(await resolveFee('consignment', 5000)).toBe(500);
    expect(await resolveFee('setup', 1000)).toBe(0); // unpriced → no fee, no code change needed
  });

  it('resolves each fee-type from the DB registry — pricing a type is config, not code', async () => {
    await FeeScheduleModel.create({
      version: 2,
      effective_at: new Date(),
      consignment_fee_bps: 1000,
      fees: {
        marketplace: { rate_bps: 1000 },
        consignment: { rate_bps: 1000 },
        customer_service: { rate_bps: 300, min_cents: 50 }, // 3% with a floor
        setup: { flat_cents: 500 }, // fixed, base-independent
      },
    });
    feeService.invalidateFeeCache();

    expect(await resolveFee('customer_service', 1000)).toBe(50); // 30 floored to 50
    expect(await resolveFee('customer_service', 10000)).toBe(300); // 3%
    expect(await resolveFee('setup', 1000)).toBe(500); // flat
    expect(await resolveFee('setup', 99999)).toBe(500); // flat is base-independent
    expect(await resolveFee('marketplace', 2000)).toBe(200); // back-compat 10% preserved

    await FeeScheduleModel.deleteMany({});
    feeService.invalidateFeeCache();
  });
});

describe('full fee taxonomy — customer service + processing (R8/R10)', () => {
  afterAll(() => feeService.setOrderFeeFlags({ customerService: false, processing: false }));

  it('resolveOrderFeeRates: both flags off = all zero (launch = transparency-first)', async () => {
    feeService.setOrderFeeFlags({ customerService: false, processing: false });
    const rates = await feeService.resolveOrderFeeRates();
    expect(rates.serviceFeeBps).toBe(0);
    expect(rates.processingBps).toBe(0);
    expect(rates.processingFlatCents).toBe(0);
  });

  it('resolveOrderFeeRates: flags on surface the registry rules (3% bounded, Stripe pass-through)', async () => {
    feeService.setOrderFeeFlags({ customerService: true, processing: true });
    const rates = await feeService.resolveOrderFeeRates();
    expect(rates.serviceFeeBps).toBe(300); // 3%
    expect(rates.serviceFeeMinCents).toBe(50); // $0.50 floor
    expect(rates.serviceFeeMaxCents).toBe(1000); // $10 cap
    expect(rates.processingBps).toBe(290); // 2.9%
    expect(rates.processingFlatCents).toBe(30); // + 30¢
    feeService.setOrderFeeFlags({ customerService: false, processing: false });
  });

  it('service fee is a bounded 3% line; processing itemized on the running total', () => {
    const rates = {
      taxBps: 0,
      deliveryCents: 0,
      serviceFeeBps: 300,
      serviceFeeMinCents: 50,
      serviceFeeMaxCents: 1000,
      processingBps: 290,
      processingFlatCents: 30,
    };
    // Mid-range: 3% of 2000 = 60 (within bounds); processing on 2060 = floor(59.74)+30 = 89.
    const mid = computeOrderBreakdown({ subtotalCents: 2000, rates });
    expect(mid.serviceFeeCents).toBe(60);
    expect(mid.processingFeeCents).toBe(89);
    expect(mid.totalCents).toBe(2149);

    // Small order → 3% (15) floored to the $0.50 minimum.
    expect(computeOrderBreakdown({ subtotalCents: 500, rates }).serviceFeeCents).toBe(50);
    // Large order → 3% (3000) capped at the $10 maximum.
    expect(computeOrderBreakdown({ subtotalCents: 100000, rates }).serviceFeeCents).toBe(1000);
  });

  it('service fee off (bps 0) never applies the minimum — no phantom fee', () => {
    const b = computeOrderBreakdown({
      subtotalCents: 1000,
      rates: {
        taxBps: 0,
        deliveryCents: 0,
        serviceFeeBps: 0,
        serviceFeeMinCents: 50,
        serviceFeeMaxCents: 1000,
        processingBps: 0,
        processingFlatCents: 0,
      },
    });
    expect(b.serviceFeeCents).toBe(0);
    expect(b.totalCents).toBe(1000);
  });
});

describe('charge() records the resolved fee-type (R7 auditability)', () => {
  it('defaults to marketplace and persists fee_type + resolved fee on the transaction', async () => {
    await FeeScheduleModel.deleteMany({});
    feeService.invalidateFeeCache();

    const sellerId = await seedUser({ authProviderId: 'fees|seller', roles: ['seller'] });
    const customerId = await seedUser({ authProviderId: 'fees|customer', roles: ['customer'] });
    const acct = await paymentsService.ensureConnectedAccount('user', sellerId);
    fakeStripe.enableAccount(acct.stripe_account_id);
    await paymentsService.refreshAccountStatus(acct.stripe_account_id);

    const res = await paymentsService.charge({
      customerId,
      counterpartyType: 'seller',
      counterpartyId: sellerId,
      amountCents: 1000,
      idempotencyKey: 'fees-charge-1',
    });
    expect(res.platformFeeCents).toBe(100); // 10% marketplace fallback

    const txn = await TransactionModel.findById(res.transactionId).lean();
    expect(txn?.fee_type).toBe('marketplace');
    expect(txn?.platform_fee_cents).toBe(100);
  });
});
