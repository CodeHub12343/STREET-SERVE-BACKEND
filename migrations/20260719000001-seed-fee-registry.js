/* eslint-env node */
// Seed the typed fee registry (DEBT1) onto fee_schedule v1. Backfills the `fees` map keyed by
// fee-type so pricing is config, not code. Backward-compatible: `consignment_fee_bps` is left in
// place, and marketplace/consignment mirror it at 10%. Idempotent (a plain $set). See
// PHASE_1_IMPLEMENTATION_PLAN.md §2 and payments/fees.ts.
const now = new Date();

// rate_bps = basis points (1000 = 10%); flat_cents = fixed component. Unpriced types are seeded at 0
// so ops sees the full registry and can price them without a schema/code change (esp. RTO, post-MVP).
// Whether the customer is actually charged customer_service / processing is gated by the
// CUSTOMER_SERVICE_FEE_ENABLED / PROCESSING_FEE_ENABLED env flags (OFF at launch, R8/R10). The
// registry just holds the priced rules so flipping a flag applies a correctly-bounded line.
const FEE_REGISTRY = {
  marketplace: { rate_bps: 1000, flat_cents: 0 },
  consignment: { rate_bps: 1000, flat_cents: 0 },
  customer_service: { rate_bps: 300, flat_cents: 0, min_cents: 50, max_cents: 1000 }, // 3%, $0.50–$10 (R10)
  processing: { rate_bps: 290, flat_cents: 30 }, // Stripe US card pass-through 2.9% + 30¢ (R8)
  rto_installment: { rate_bps: 1000, flat_cents: 0 }, // 10% per RTO payment (R26)
  setup: { rate_bps: 0, flat_cents: 0 },
  late: { rate_bps: 0, flat_cents: 0 },
  promotion: { rate_bps: 0, flat_cents: 0 },
};

module.exports = {
  async up(db) {
    await db.collection('fee_schedule').updateOne(
      { version: 1 },
      { $set: { fees: FEE_REGISTRY, updated_fees_at: now } },
      // If v1 was never seeded (fresh env where the reference-data migration hasn't run), create a
      // complete v1 row so the registry is present regardless of migration order.
      { upsert: false },
    );
    // Fallback create for an empty collection, keeping this migration self-sufficient.
    const existing = await db.collection('fee_schedule').findOne({ version: 1 });
    if (!existing) {
      await db.collection('fee_schedule').insertOne({
        version: 1,
        effective_at: now,
        consignment_fee_bps: 1000,
        round_up_platform_cut_bps: 0,
        membership_overrides: {},
        fees: FEE_REGISTRY,
        created_by: 'system',
        created_at: now,
      });
    }
  },

  async down(db) {
    await db
      .collection('fee_schedule')
      .updateOne({ version: 1 }, { $unset: { fees: '', updated_fees_at: '' } });
  },
};
