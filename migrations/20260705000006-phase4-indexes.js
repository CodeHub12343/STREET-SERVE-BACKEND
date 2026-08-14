/* eslint-env node */
// Phase 4 indexes: consignment (hubs, products, checkouts, sales, returns, settlements),
// trust_scores, disputes, fraud_flags, seller_agreement_acceptances.
// See DATABASE_SCHEMA_PLAN.md §7/§8/§11.
module.exports = {
  async up(db) {
    await db.collection('hubs').createIndex({ business_id: 1 }, { name: 'ux_hubs_business', unique: true });

    await db.collection('products').createIndex({ hub_id: 1 }, { name: 'ix_products_hub' });

    await db
      .collection('seller_agreement_acceptances')
      .createIndex({ seller_id: 1, version: 1 }, { name: 'ux_agreement', unique: true });

    await db.collection('inventory_checkouts').createIndexes([
      { key: { seller_id: 1, status: 1 }, name: 'ix_checkout_seller' },
      { key: { hub_id: 1, status: 1 }, name: 'ix_checkout_hub' },
      { key: { expected_return_at: 1, status: 1 }, name: 'ix_checkout_overdue' },
    ]);

    await db.collection('inventory_sales').createIndex({ checkout_id: 1 }, { name: 'ix_sales_checkout' });
    await db
      .collection('inventory_returns')
      .createIndex({ checkout_id: 1 }, { name: 'ux_returns_checkout', unique: true });
    await db
      .collection('settlements')
      .createIndex({ checkout_id: 1 }, { name: 'ux_settlement_checkout', unique: true });

    await db
      .collection('trust_scores')
      .createIndex({ subject_type: 1, subject_id: 1, computed_at: -1 }, { name: 'ix_trust_subject' });

    await db.collection('disputes').createIndexes([
      { key: { status: 1, sla_due_at: 1 }, name: 'ix_disputes_sla' },
      { key: { subject_type: 1, subject_id: 1, status: 1 }, name: 'ix_disputes_subject' },
    ]);

    await db
      .collection('fraud_flags')
      .createIndex({ type: 1, status: 1, created_at: -1 }, { name: 'ix_fraud_type' });
  },

  async down(db) {
    for (const c of [
      'hubs',
      'products',
      'seller_agreement_acceptances',
      'inventory_checkouts',
      'inventory_sales',
      'inventory_returns',
      'settlements',
      'trust_scores',
      'disputes',
      'fraud_flags',
    ]) {
      await db.collection(c).dropIndexes();
    }
  },
};
