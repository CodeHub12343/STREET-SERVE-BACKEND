/* eslint-env node */
// Seed reference data: the curated launch category taxonomy (~18 rows vetted for the Modesto
// pilot, Q8/Q1), the pilot city, and fee-schedule v1. Idempotent (upsert by natural key) so it is
// safe to re-run across environments. See DATABASE_SCHEMA_PLAN.md §2/§11.
const now = new Date();

// requires_license = true for food/personal-care & notary at MVP (Q1 recommended default).
const CATEGORIES = [
  // food
  { slug: 'food-truck', name: 'Food Truck', top_level_tab: 'food', requires_license: true, regulated_by: 'County Health Dept' },
  { slug: 'dessert-truck', name: 'Dessert & Ice Cream', top_level_tab: 'food', requires_license: true, regulated_by: 'County Health Dept' },
  { slug: 'bbq-smoker', name: 'BBQ & Smoker', top_level_tab: 'food', requires_license: true, regulated_by: 'County Health Dept' },
  { slug: 'food-cart', name: 'Food Cart', top_level_tab: 'food', requires_license: true, regulated_by: 'County Health Dept' },
  // coffee
  { slug: 'coffee-cart', name: 'Coffee Cart', top_level_tab: 'coffee', requires_license: true, regulated_by: 'County Health Dept' },
  { slug: 'mobile-juice-smoothie', name: 'Juice & Smoothies', top_level_tab: 'coffee', requires_license: true, regulated_by: 'County Health Dept' },
  // services
  { slug: 'mobile-detailing', name: 'Mobile Detailing', top_level_tab: 'services', requires_license: false, regulated_by: null },
  { slug: 'mobile-car-wash', name: 'Mobile Car Wash', top_level_tab: 'services', requires_license: false, regulated_by: null },
  { slug: 'mobile-mechanic', name: 'Mobile Mechanic', top_level_tab: 'services', requires_license: false, regulated_by: null },
  { slug: 'mobile-pet-grooming', name: 'Mobile Pet Grooming', top_level_tab: 'services', requires_license: false, regulated_by: null },
  { slug: 'mobile-notary', name: 'Mobile Notary', top_level_tab: 'services', requires_license: true, regulated_by: 'CA Secretary of State' },
  { slug: 'mobile-dj-events', name: 'Mobile DJ & Events', top_level_tab: 'services', requires_license: false, regulated_by: null },
  { slug: 'mobile-locksmith', name: 'Mobile Locksmith', top_level_tab: 'services', requires_license: false, regulated_by: null },
  // shopping (consignment goods)
  { slug: 'handmade-crafts', name: 'Handmade & Crafts', top_level_tab: 'shopping', requires_license: false, regulated_by: null },
  { slug: 'apparel-accessories', name: 'Apparel & Accessories', top_level_tab: 'shopping', requires_license: false, regulated_by: null },
  { slug: 'art-prints', name: 'Art & Prints', top_level_tab: 'shopping', requires_license: false, regulated_by: null },
  { slug: 'books-media', name: 'Books & Media', top_level_tab: 'shopping', requires_license: false, regulated_by: null },
  // more
  { slug: 'faith-based', name: 'Faith-Based Products', top_level_tab: 'more', requires_license: false, regulated_by: null },
  { slug: 'fundraising-goods', name: 'Fundraising Goods', top_level_tab: 'more', requires_license: false, regulated_by: null },
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

    await db.collection('cities').updateOne(
      { slug: 'modesto-ca' },
      {
        $set: {
          name: 'Modesto',
          state: 'CA',
          status: 'live',
          launch_date: now,
          feature_flags: { consignment: true, live_map: true },
          updated_at: now,
        },
        $setOnInsert: { created_at: now },
      },
      { upsert: true },
    );

    await db.collection('fee_schedule').updateOne(
      { version: 1 },
      {
        $set: {
          effective_at: now,
          consignment_fee_bps: 1000, // 10% platform fee on settled consignment sales
          round_up_platform_cut_bps: 0, // FR-6.4: round-up tips are 100% to the vendor
          membership_overrides: {},
          created_by: 'system',
        },
        $setOnInsert: { created_at: now },
      },
      { upsert: true },
    );
  },

  async down(db) {
    await db.collection('categories').deleteMany({ slug: { $in: CATEGORIES.map((c) => c.slug) } });
    await db.collection('cities').deleteOne({ slug: 'modesto-ca' });
    await db.collection('fee_schedule').deleteOne({ version: 1 });
  },
};
