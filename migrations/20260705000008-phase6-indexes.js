/* eslint-env node */
// Phase 6 indexes: ai_recommendations log + products.category_id (affinity/time-of-day signal).
// See DATABASE_SCHEMA_PLAN.md §7.
module.exports = {
  async up(db) {
    await db
      .collection('ai_recommendations')
      .createIndex(
        { seller_id: 1, recommendation_type: 1, shown_at: -1 },
        { name: 'ix_ai_rec_seller' },
      );
    await db.collection('products').createIndex({ category_id: 1 }, { name: 'ix_products_category' });
  },

  async down(db) {
    await db.collection('ai_recommendations').dropIndexes();
    await db
      .collection('products')
      .dropIndex('ix_products_category')
      .catch(() => undefined);
  },
};
