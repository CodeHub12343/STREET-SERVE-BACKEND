/* eslint-env node */
// Phase 1 indexes: payments (connected_accounts, transactions) and vendors (businesses,
// menu_items, category_suggestions, license_documents). Mirrors DATABASE_SCHEMA_PLAN.md §2/§6.
module.exports = {
  async up(db) {
    await db.collection('connected_accounts').createIndexes([
      { key: { stripe_account_id: 1 }, name: 'ux_connacct_stripe', unique: true },
      { key: { owner_type: 1, owner_id: 1 }, name: 'ux_connacct_owner', unique: true },
    ]);

    await db.collection('transactions').createIndexes([
      {
        key: { payment_intent_ref: 1 },
        name: 'ux_txn_pi',
        unique: true,
        partialFilterExpression: { payment_intent_ref: { $type: 'string' } },
      },
      {
        key: { idempotency_key: 1 },
        name: 'ux_txn_idem',
        unique: true,
        partialFilterExpression: { idempotency_key: { $type: 'string' } },
      },
      { key: { customer_id: 1, created_at: -1 }, name: 'ix_txn_customer' },
      { key: { counterparty_id: 1, created_at: -1 }, name: 'ix_txn_counterparty' },
      { key: { status: 1 }, name: 'ix_txn_status' },
    ]);

    await db.collection('businesses').createIndexes([
      { key: { owner_user_id: 1 }, name: 'ix_biz_owner' },
      { key: { category_id: 1 }, name: 'ix_biz_category' },
      { key: { is_hub: 1 }, name: 'ix_biz_hub' },
      { key: { service_area: '2dsphere' }, name: 'gx_biz_service_area' },
    ]);

    await db
      .collection('menu_items')
      .createIndex({ business_id: 1, is_available: 1 }, { name: 'ix_menu_business' });

    await db
      .collection('category_suggestions')
      .createIndex({ status: 1 }, { name: 'ix_catsug_status' });

    await db
      .collection('license_documents')
      .createIndex(
        { business_id: 1, category_id: 1, status: 1 },
        { name: 'ix_license_business_cat' },
      );
  },

  async down(db) {
    await db.collection('connected_accounts').dropIndexes();
    await db.collection('transactions').dropIndexes();
    await db.collection('businesses').dropIndexes();
    await db.collection('menu_items').dropIndexes();
    await db.collection('category_suggestions').dropIndexes();
    await db.collection('license_documents').dropIndexes();
  },
};
