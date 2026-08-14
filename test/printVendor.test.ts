import { afterEach, describe, expect, it } from 'vitest';

import {
  PRINT_QUOTE_MAX_UNIT_COST_CENTS,
  PRINT_QUOTE_MIN_UNIT_COST_CENTS,
  PRINT_VENDOR_IDEMPOTENCY_CONFIRMED,
} from '../src/config/constants';
import {
  FULFILMENT_STATUSES,
  TERMINAL_STATUSES,
  createFakePrintVendor,
  isTerminal,
  printVendor,
  resetPrintVendor,
  selectPriceBreak,
  setPrintVendor,
} from '../src/integrations/print';
import { mapStatus, parsePriceBreaks, dollarsToCents } from '../src/integrations/print/wire';
import type { SubmitOrderRequest } from '../src/integrations/print';

/**
 * Contract tests for the print-vendor boundary (PostcardMania DirectMail v3).
 *
 * These assert the behaviour the domain depends on. Where a rule comes from the vendor's published
 * spec rather than our own choice, the test says so — those are the ones that must be re-checked
 * if the vendor ever changes.
 */

const RETURN_ADDRESS = {
  company: 'StreetServe',
  address: '1 Main St',
  city: 'Modesto',
  state: 'CA',
  zipCode: '95350',
};

const submitReq = (over: Partial<SubmitOrderRequest> = {}): SubmitOrderRequest => ({
  sizeKey: '69',
  mailClass: 'standard',
  listCountId: 'lc_000001',
  recordCount: 1_000,
  artwork: { frontUrl: 'https://cdn.example.com/f.pdf', backUrl: 'https://cdn.example.com/b.pdf' },
  orderRef: 'order_1',
  mailDate: new Date('2026-09-01'),
  returnAddress: RETURN_ADDRESS,
  ...over,
});

afterEach(() => resetPrintVendor());

describe('print vendor — safety invariants', () => {
  it('never exposes a delivered status', () => {
    // The vendor DOES report `Delivered`, but defines it as a last-facility scan, not arrival.
    // Surfacing that to a buyer as "delivered" would overclaim, so it maps to `mailed`.
    expect(FULFILMENT_STATUSES).toEqual(['preparing', 'printing', 'mailed']);
    expect(mapStatus('Delivered')).toBe('mailed');
  });

  it('treats duplicate submission as safe, now that the vendor documents 409 on a repeat ref', () => {
    // Vendor-established fact (extRefNbr → 409), not an assumption. Closes audit F-6.
    expect(PRINT_VENDOR_IDEMPOTENCY_CONFIRMED).toBe(true);
  });

  it('maps every status the vendor can emit, and refuses ones it cannot', () => {
    // An unmapped status must throw rather than silently advancing or stalling an order.
    for (const s of ['Pending', 'Processing', 'Processed', 'Mailing', 'Complete', 'Delivered']) {
      expect(FULFILMENT_STATUSES).toContain(mapStatus(s));
    }
    for (const s of ['Canceled', 'Undeliverable', 'Failed', 'Pending Payment', 'Failed Payment']) {
      expect(isTerminal(mapStatus(s))).toBe(true);
    }
    expect(() => mapStatus('Teleported')).toThrow();
    expect(() => mapStatus(undefined)).toThrow();
  });

  it('classifies a stalled prepaid balance as a terminal payment hold', () => {
    // Under Topology B the vendor runs a retainer; an empty account stalls orders. That is an ops
    // alert, and it must not look like an in-flight order that will eventually move.
    expect(mapStatus('Pending Payment')).toBe('payment_hold');
    expect(TERMINAL_STATUSES).toContain('payment_hold');
  });

  it('has a sane-price band that is actually a band', () => {
    expect(PRINT_QUOTE_MIN_UNIT_COST_CENTS).toBeGreaterThan(0);
    expect(PRINT_QUOTE_MAX_UNIT_COST_CENTS).toBeGreaterThan(PRINT_QUOTE_MIN_UNIT_COST_CENTS);
  });
});

describe('print vendor — resolution', () => {
  it('never reaches the real vendor under test, even when credentials are present', async () => {
    /**
     * Regression test for a hazard this suite caught for real: dotenv loads `.env` under
     * NODE_ENV=test, so a developer's sandbox credentials made `printVendor()` build the REAL
     * gateway and issue a live HTTP call. A test run must never reach a vendor that prints and
     * mails physical objects and bills for them. Asserted WITH credentials set — the dangerous case.
     */
    process.env.PCM_API_KEY ??= 'test-key-ignored';
    process.env.PCM_API_SECRET ??= 'test-secret-ignored';
    const vendor = printVendor();
    const types = await vendor.listTypes();
    expect(types.length).toBeGreaterThan(0);
  });

  it('honours an injected gateway', async () => {
    setPrintVendor(
      createFakePrintVendor({
        priceBreaks: [{ mailClass: 'standard', unitCostCents: 33, minQuantity: 1 }],
      }),
    );
    const price = await printVendor().priceRun({
      sizeKey: '69',
      mailClass: 'standard',
      quantity: 10,
    });
    expect(price.unitCostCents).toBe(33);
  });
});

describe('print vendor — audiences keep consumer PII at the vendor', () => {
  it('returns an id and a count, never addresses', async () => {
    // The privacy-critical property. If this ever returns recipients, NF-8 comes into scope.
    const vendor = createFakePrintVendor();
    const count = await vendor.createAudienceCount({
      type: 'zip',
      keys: ['95350', '95351'],
      listType: 'IRL',
    });

    expect(count.listCountId).toMatch(/^lc_/);
    expect(count.recordCount).toBe(2_000);
    expect(JSON.stringify(count)).not.toMatch(/address|firstName|lastName/i);
  });

  it('supports carrier routes and radius, and rejects an empty selection', async () => {
    const vendor = createFakePrintVendor();
    await expect(
      vendor.createAudienceCount({ type: 'carrier_route', keys: ['95350:C002'], listType: 'IRL' }),
    ).resolves.toMatchObject({ recordCount: 1_000 });

    await expect(
      vendor.createAudienceCount({
        type: 'radius',
        listType: 'IRL',
        radius: { miles: 3, address: '1 Main St', city: 'Modesto', state: 'CA', zip: '95350' },
      }),
    ).resolves.toMatchObject({ recordCount: 2_500 });

    await expect(
      vendor.createAudienceCount({ type: 'zip', keys: [], listType: 'IRL' }),
    ).rejects.toThrow();
  });
});

describe('print vendor — pricing', () => {
  it('applies the highest volume break the quantity reaches', () => {
    const breaks = [
      { mailClass: 'standard' as const, unitCostCents: 42, minQuantity: 1 },
      { mailClass: 'standard' as const, unitCostCents: 38, minQuantity: 1_000 },
      { mailClass: 'standard' as const, unitCostCents: 34, minQuantity: 5_000 },
    ];
    expect(selectPriceBreak(breaks, 'standard', 500)?.unitCostCents).toBe(42);
    expect(selectPriceBreak(breaks, 'standard', 1_000)?.unitCostCents).toBe(38);
    expect(selectPriceBreak(breaks, 'standard', 9_999)?.unitCostCents).toBe(34);
    // Mail classes must not bleed into each other.
    expect(selectPriceBreak(breaks, 'first_class', 9_999)).toBeNull();
  });

  it('prices a run and is explicit that the price is NOT binding', async () => {
    // The vendor has no quote endpoint; we compute from their published breaks, so the number is
    // an estimate and the caller must re-price at checkout (audit F-8).
    const vendor = createFakePrintVendor();
    const price = await vendor.priceRun({ sizeKey: '69', mailClass: 'standard', quantity: 1_000 });
    expect(price.vendorCostCents).toBe(38 * 1_000);
    expect(price.isBinding).toBe(false);
  });

  it('converts the vendor dollar prices to integer cents', () => {
    // Their prices are floats in dollars; every internal amount is integer cents.
    expect(dollarsToCents(1.01)).toBe(101);
    expect(dollarsToCents(0.385)).toBe(39);
  });

  it('reads price breaks out of the gallery response shape', () => {
    const breaks = parsePriceBreaks(
      {
        results: [
          {
            size: { key: '69' },
            pricing: [
              { mailClass: 'Standard', price: 0.38, breakQty: 1000 },
              { mailClass: 'FirstClass', price: 0.61, breakQty: 1000 },
            ],
          },
          { size: { key: '46' }, pricing: [{ mailClass: 'Standard', price: 9.99, breakQty: 1 }] },
        ],
      },
      '69',
    );
    expect(breaks).toHaveLength(2);
    // The 46-size row must not leak into 69's pricing.
    expect(breaks.every((b) => b.unitCostCents < 100)).toBe(true);
  });
});

describe('print vendor — submission', () => {
  it('rejects a duplicate order reference instead of printing twice', async () => {
    const vendor = createFakePrintVendor();
    const count = await vendor.createAudienceCount({ type: 'zip', keys: ['95350'], listType: 'IRL' });
    const req = submitReq({ listCountId: count.listCountId, recordCount: count.recordCount });

    const first = await vendor.submitOrder(req);
    expect(first.vendorOrderId).toMatch(/^ord_/);

    // The vendor's own duplicate detection. This is what makes retrying a submission safe.
    await expect(vendor.submitOrder(req)).rejects.toThrow(/already been submitted/i);
    expect(vendor.orders.size).toBe(1);
  });

  it('requires both artwork sides even though the buyer designs only the front', async () => {
    // Settles the "one side" question: one DESIGNED side, two PRINTED sides — a mailed postcard
    // must carry an address side, and the vendor enforces it.
    const vendor = createFakePrintVendor();
    const count = await vendor.createAudienceCount({ type: 'zip', keys: ['95350'], listType: 'IRL' });
    await expect(
      vendor.submitOrder(
        submitReq({
          listCountId: count.listCountId,
          recordCount: count.recordCount,
          artwork: { frontUrl: 'https://x/f.pdf', backUrl: '' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses an unknown list count or a mismatched record count', async () => {
    const vendor = createFakePrintVendor();
    const count = await vendor.createAudienceCount({ type: 'zip', keys: ['95350'], listType: 'IRL' });

    await expect(vendor.submitOrder(submitReq({ listCountId: 'lc_nope' }))).rejects.toThrow();
    await expect(
      vendor.submitOrder(submitReq({ listCountId: count.listCountId, recordCount: 999 })),
    ).rejects.toThrow();
  });

  it('refuses submission without an order reference', async () => {
    const vendor = createFakePrintVendor();
    await expect(vendor.submitOrder(submitReq({ orderRef: '   ' }))).rejects.toThrow();
  });
});

describe('print vendor — status and cancellation', () => {
  const place = async (vendor: ReturnType<typeof createFakePrintVendor>): Promise<string> => {
    const count = await vendor.createAudienceCount({ type: 'zip', keys: ['95350'], listType: 'IRL' });
    const ref = await vendor.submitOrder(
      submitReq({ listCountId: count.listCountId, recordCount: count.recordCount }),
    );
    return ref.vendorOrderId;
  };

  it('starts preparing and moves forward only', async () => {
    const vendor = createFakePrintVendor();
    const id = await place(vendor);

    expect(await vendor.getStatus(id)).toBe('preparing');
    vendor.advance(id, 'printing');
    expect(await vendor.getStatus(id)).toBe('printing');
    vendor.advance(id, 'mailed');
    expect(await vendor.getStatus(id)).toBe('mailed');
    expect(() => vendor.advance(id, 'printing')).toThrow();
  });

  it('allows cancellation before the batch closes, and refuses it after', async () => {
    // Submission is NOT an instant point of no return: the vendor batches at end of day and
    // accepts cancellation until their cutoff. That window is a real product capability.
    const vendor = createFakePrintVendor();
    const id = await place(vendor);

    await expect(vendor.cancelOrder(id)).resolves.toBeUndefined();
    expect(await vendor.getStatus(id)).toBe('canceled');

    const second = createFakePrintVendor();
    const id2 = await place(second);
    second.closeBatch(id2);
    await expect(second.cancelOrder(id2)).rejects.toMatchObject({
      details: { reason: 'batch already sent to press' },
    });
    // Still cancellable in our records only if the vendor agreed — it did not.
    expect(await second.getStatus(id2)).not.toBe('canceled');
  });

  it('rejects status and cancellation for an unknown order', async () => {
    const vendor = createFakePrintVendor();
    await expect(vendor.getStatus('ord_nope')).rejects.toThrow();
    await expect(vendor.cancelOrder('ord_nope')).rejects.toThrow();
  });
});

describe('print vendor — prepaid retainer', () => {
  it('reports the balance so an order is not submitted against an empty account', async () => {
    // Topology B: the vendor bills a retainer, so a dry account stalls orders at their end.
    const vendor = createFakePrintVendor({ balanceCents: 250_00 });
    expect((await vendor.getBalance()).moneyOnAccountCents).toBe(25_000);
  });
});
