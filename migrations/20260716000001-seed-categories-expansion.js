/* eslint-env node */
// Category taxonomy expansion (19 → 25 rows, staying inside the documented ~15–25 launch scope,
// DATABASE_SCHEMA_PLAN.md §2 / Q8).
//
// Every row here closes a gap between the taxonomy and something the product ALREADY advertises,
// so a vendor who saw the pitch can actually pick their category:
//   • Beauty / Barber / Nails — "Beauty" and "Grooming" are landing-page category chips, and
//     "Bloom Mobile Beauty" is one of the seven vendors in the hero simulation. Only *pet*
//     grooming existed. Licensed in CA by the Board of Barbering and Cosmetology, which is also
//     what the landing FAQ means by "personal services are regulated almost everywhere".
//   • Device / Bike repair — "Repairs" is a landing chip; only Mobile Mechanic (vehicles) existed.
//   • Plants & Garden — "Green Thumb Plants" is a hero-simulation vendor.
//
// A separate migration rather than an edit to 20260705000002 because that one may already be
// applied elsewhere. Idempotent (upsert by slug), same as the original seed.
const now = new Date();

const CATEGORIES = [
  // services — personal care is licensed in CA (Board of Barbering and Cosmetology).
  {
    slug: 'mobile-beauty',
    name: 'Mobile Beauty & Esthetics',
    top_level_tab: 'services',
    requires_license: true,
    regulated_by: 'CA Board of Barbering and Cosmetology',
  },
  {
    slug: 'mobile-barber',
    name: 'Mobile Barber & Hair',
    top_level_tab: 'services',
    requires_license: true,
    regulated_by: 'CA Board of Barbering and Cosmetology',
  },
  {
    slug: 'mobile-nails',
    name: 'Mobile Nails',
    top_level_tab: 'services',
    requires_license: true,
    regulated_by: 'CA Board of Barbering and Cosmetology',
  },
  // services — repair trades beyond vehicles; no state licence at this scope.
  {
    slug: 'mobile-device-repair',
    name: 'Phone & Device Repair',
    top_level_tab: 'services',
    requires_license: false,
    regulated_by: null,
  },
  {
    slug: 'mobile-bike-repair',
    name: 'Bike Repair',
    top_level_tab: 'services',
    requires_license: false,
    regulated_by: null,
  },
  // shopping
  {
    slug: 'plants-garden',
    name: 'Plants & Garden',
    top_level_tab: 'shopping',
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
