/* eslint-env node */
// BP-5: the proposed categories from BUSINESS_CATEGORY_MATRIX.md §6 — mobile trades named in the
// business-platform brief that the taxonomy didn't cover (25 → 32 rows).
//
// Every one slots into an EXISTING archetype, which is the point: a new category inherits a
// complete product with no code change. That is the evidence the 4-archetype model holds.
//
// DELIBERATELY EXCLUDED — Mobile Medical / Wellness. Regulated healthcare is a different risk
// class (licensure, insurance, HIPAA-adjacent data) and BUSINESS_CATEGORY_MATRIX.md §6 flags it
// as requiring legal counsel before it ships. Adding the row is the easy part; being allowed to
// carry those businesses is not. Do not add it here without sign-off.
//
// Idempotent upsert-by-slug like the other seeds; `npm run seed` applies every `*-seed-*` file.
const now = new Date();

const CATEGORIES = [
  // ── on_demand_service: the customer needs help now, wherever they are ───────────────────
  {
    slug: 'pressure-washing',
    name: 'Pressure Washing',
    top_level_tab: 'services',
    archetype: 'on_demand_service',
    requires_license: false,
    regulated_by: null,
  },
  {
    slug: 'landscaping-lawn',
    name: 'Landscaping & Lawn',
    top_level_tab: 'services',
    archetype: 'on_demand_service',
    requires_license: false,
    regulated_by: null,
  },
  {
    slug: 'roadside-assistance',
    name: 'Roadside Assistance',
    top_level_tab: 'services',
    archetype: 'on_demand_service',
    requires_license: false,
    regulated_by: null,
  },
  {
    slug: 'courier-delivery',
    name: 'Courier & Delivery',
    top_level_tab: 'services',
    archetype: 'on_demand_service',
    requires_license: false,
    regulated_by: null,
  },
  // ── appointment_service: booked ahead, often recurring ─────────────────────────────────
  {
    slug: 'cleaning-services',
    name: 'Cleaning Services',
    top_level_tab: 'services',
    archetype: 'appointment_service',
    requires_license: false,
    regulated_by: null,
  },
  {
    slug: 'moving-hauling',
    name: 'Moving & Hauling',
    top_level_tab: 'services',
    archetype: 'appointment_service',
    requires_license: false,
    regulated_by: null,
  },
  // ── goods_seller ───────────────────────────────────────────────────────────────────────
  {
    slug: 'mobile-boutique',
    name: 'Mobile Boutique',
    top_level_tab: 'shopping',
    archetype: 'goods_seller',
    requires_license: false,
    regulated_by: null,
  },
];

module.exports = {
  async up(db) {
    for (const c of CATEGORIES) {
      await db.collection('categories').updateOne(
        { slug: c.slug },
        {
          $set: {
            name: c.name,
            top_level_tab: c.top_level_tab,
            archetype: c.archetype,
            module_overrides: {},
            requires_license: c.requires_license,
            regulated_by: c.regulated_by,
            active: true,
            parent_category_id: null,
            updated_at: now,
          },
          $setOnInsert: { created_at: now },
        },
        { upsert: true },
      );
    }
  },

  async down(db) {
    await db.collection('categories').deleteMany({ slug: { $in: CATEGORIES.map((c) => c.slug) } });
  },
};
