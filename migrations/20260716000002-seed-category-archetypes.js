/* eslint-env node */
// Backfill `archetype` (+ the rare `module_overrides`) onto every category — BP-1 of
// BUSINESS_IMPLEMENTATION_ROADMAP.md, mapping per BUSINESS_CATEGORY_MATRIX.md §5.
//
// The archetype is what supplies a business's default modules, so this is the row that makes a
// food truck's product differ from a mechanic's. Idempotent upsert-by-slug like the other seeds;
// `npm run seed` picks it up automatically (it applies every `*-seed-*` migration in order).
//
// Categories NOT listed here still resolve: the resolver falls back to DEFAULT_ARCHETYPE_BY_TAB.
// This migration makes the mapping explicit and reviewable rather than inferred.

const ARCHETYPE_BY_SLUG = {
  // ── counter_serve: product, on the spot ────────────────────────────────────────────────
  'food-truck': 'counter_serve',
  'food-cart': 'counter_serve',
  'bbq-smoker': 'counter_serve',
  'dessert-truck': 'counter_serve',
  'coffee-cart': 'counter_serve',
  'mobile-juice-smoothie': 'counter_serve',

  // ── appointment_service: time, booked ahead ────────────────────────────────────────────
  'mobile-barber': 'appointment_service',
  'mobile-beauty': 'appointment_service',
  'mobile-nails': 'appointment_service',
  'mobile-pet-grooming': 'appointment_service',
  'mobile-notary': 'appointment_service',
  'mobile-dj-events': 'appointment_service',

  // ── on_demand_service: time, dispatched now ────────────────────────────────────────────
  'mobile-mechanic': 'on_demand_service',
  'mobile-locksmith': 'on_demand_service',
  'mobile-car-wash': 'on_demand_service',
  'mobile-detailing': 'on_demand_service',
  'mobile-device-repair': 'on_demand_service',
  'mobile-bike-repair': 'on_demand_service',

  // ── goods_seller: physical goods ───────────────────────────────────────────────────────
  'handmade-crafts': 'goods_seller',
  'apparel-accessories': 'goods_seller',
  'art-prints': 'goods_seller',
  'books-media': 'goods_seller',
  'plants-garden': 'goods_seller',
  'faith-based': 'goods_seller',
  'fundraising-goods': 'goods_seller',
};

// Per-category deviations from the archetype defaults (BUSINESS_CATEGORY_MATRIX.md §5).
const MODULE_OVERRIDES_BY_SLUG = {
  // Detailing is commonly booked ahead as well as flagged down.
  'mobile-detailing': { booking: true },
  // Supplying street sellers is the entire point of the category.
  'fundraising-goods': { consignment: true },
};

module.exports = {
  async up(db) {
    const now = new Date();
    for (const [slug, archetype] of Object.entries(ARCHETYPE_BY_SLUG)) {
      await db.collection('categories').updateOne(
        { slug },
        {
          $set: {
            archetype,
            module_overrides: MODULE_OVERRIDES_BY_SLUG[slug] ?? {},
            updated_at: now,
          },
        },
        // No upsert: this migration annotates categories seeded by 20260705000002 /
        // 20260716000001. Creating a bare {slug, archetype} row here would violate the
        // required name/top_level_tab fields.
        { upsert: false },
      );
    }
  },

  async down(db) {
    await db
      .collection('categories')
      .updateMany(
        { slug: { $in: Object.keys(ARCHETYPE_BY_SLUG) } },
        { $unset: { archetype: '', module_overrides: '' } },
      );
  },
};
