/* eslint-env node */
// A-1: flag products whose `listing_type` the settlement code cannot honour.
//
// `listing_type` has always accepted consignment | wholesale | rental | donation, but only the
// consignment path exists — checkout, sale logging, return and settle() implement it and nothing
// else. Any row carrying one of the other three sits directly upstream of the money path and would
// settle on terms nobody agreed to (a rental split as a sale, a donation paying a seller share).
//
// This migration does NOT delete or rewrite those rows. Their stored value is real product intent
// and must keep meaning what it meant; destroying it would lose the very list of things to build.
// It marks them for review instead. The actual block lives in the service layer, which refuses any
// unsupported listing type at both product creation and checkout regardless of this flag.
//
// Idempotent: re-running only re-stamps rows that are still unflagged.
const SUPPORTED = ['consignment'];

module.exports = {
  async up(db) {
    const products = db.collection('products');

    // Rows written before the field existed default to consignment — normalise them explicitly so
    // "no listing_type" can never be read as "unknown listing type" by a later query.
    await products.updateMany(
      { listing_type: { $in: [null, ''] } },
      { $set: { listing_type: 'consignment' } },
    );
    await products.updateMany(
      { listing_type: { $exists: false } },
      { $set: { listing_type: 'consignment' } },
    );

    const flaggedAt = new Date();
    const result = await products.updateMany(
      { listing_type: { $nin: SUPPORTED }, listing_type_flagged_at: null },
      { $set: { listing_type_flagged_at: flaggedAt } },
    );

    // Also stamp rows that never had the field at all (pre-A-1 documents).
    await products.updateMany(
      { listing_type: { $nin: SUPPORTED }, listing_type_flagged_at: { $exists: false } },
      { $set: { listing_type_flagged_at: flaggedAt } },
    );

    const flagged = await products.countDocuments({ listing_type: { $nin: SUPPORTED } });
    if (flagged > 0) {
      const byType = await products
        .aggregate([
          { $match: { listing_type: { $nin: SUPPORTED } } },
          { $group: { _id: '$listing_type', count: { $sum: 1 } } },
        ])
        .toArray();
      // Loud on purpose: these are live listings that just became un-checkout-able, and a hub owner
      // will ask why. Whoever runs this needs the list in front of them.
      console.warn(
        `[A-1] ${flagged} product(s) carry an unsupported listing_type and are now blocked from checkout:`,
        byType.map((r) => `${r._id}=${r.count}`).join(', '),
      );
    }

    // Index the review queue — admin tooling reads "what is flagged" far more often than it writes.
    await products.createIndex(
      { listing_type_flagged_at: 1 },
      { name: 'listing_type_flagged_at_1', sparse: true },
    );

    void result;
  },

  async down(db) {
    const products = db.collection('products');
    await products.updateMany(
      { listing_type_flagged_at: { $ne: null } },
      { $set: { listing_type_flagged_at: null } },
    );
    await products.dropIndex('listing_type_flagged_at_1').catch(() => {
      /* index may not exist */
    });
  },
};
