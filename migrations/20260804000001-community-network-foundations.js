/* eslint-env node */
/**
 * Phase 2 foundations for the community network (Delivery Assist, Pay It Forward, Boost My
 * Marketing). Two independent changes that share a release:
 *
 *  1. Two new fee types on the registry (X-1), BOTH SEEDED AT ZERO.
 *  2. The `delivery` city feature flag, seeded OFF everywhere (DAN-10).
 *
 * ## Why the fees are seeded at zero rather than at a guess
 *
 * `delivery_coordination` cannot be priced honestly until the driver payout and the insurance cost
 * are known, and both are Phase 5 inputs. `campaign_service` covers a print vendor's handling and no
 * vendor is contracted yet (MB-8). Seeding a plausible-looking number would put a made-up price into
 * the registry that ops would reasonably assume somebody had chosen.
 *
 * Zero is safe because nothing charges either fee yet: `delivery_coordination` is applied at DAN-8
 * and `campaign_service` at MB-3, neither of which exists. Pricing them is a GATE on those tasks —
 * see FINAL_IMPLEMENTATION_CHECKLIST.md — not a follow-up.
 *
 * ## Why the delivery flag is default-off
 *
 * ADR-004 requires insurance to be bound before the first real delivery, and that is not a code
 * change. The order path uses `isFeatureExplicitlyEnabled`, so an unconfigured city already refuses;
 * this writes the flag explicitly so the pilot city's row SHOWS `delivery: false` rather than
 * relying on absence, and turning delivery on becomes a visible, deliberate edit.
 */
const now = new Date();

const NEW_FEES = {
  // Flat, not a percentage: it prices the coordination, which costs the same on an $8 basket as on
  // an $80 one. Same reasoning as wave_convenience. UNPRICED — see the header.
  'fees.delivery_coordination': { rate_bps: 0, flat_cents: 0 },
  // Deducted from a FUNDED campaign only, never from a contribution (ADR-006 §6). UNPRICED.
  'fees.campaign_service': { rate_bps: 0, flat_cents: 0 },
};

module.exports = {
  async up(db) {
    await db
      .collection('fee_schedule')
      .updateOne({ version: 1 }, { $set: { ...NEW_FEES, updated_fees_at: now } });

    // Default-deny in data as well as in code. `$set` on a nested key leaves other flags untouched.
    await db
      .collection('cities')
      .updateMany({}, { $set: { 'feature_flags.delivery': false, updated_at: now } });
  },

  async down(db) {
    await db.collection('fee_schedule').updateOne(
      { version: 1 },
      {
        $unset: { 'fees.delivery_coordination': '', 'fees.campaign_service': '' },
        $set: { updated_fees_at: now },
      },
    );
    await db
      .collection('cities')
      .updateMany({}, { $unset: { 'feature_flags.delivery': '' }, $set: { updated_at: now } });
  },
};
