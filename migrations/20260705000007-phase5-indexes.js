/* eslint-env node */
// Phase 5 indexes: growth (ping_budgets, pings, gifts, giveaways, giveaway_claims,
// spot_me_requests, block_party_events). See DATABASE_SCHEMA_PLAN.md §4/§9.
module.exports = {
  async up(db) {
    await db
      .collection('ping_budgets')
      .createIndex({ business_id: 1 }, { name: 'ux_ping_budget_business', unique: true });

    await db.collection('pings').createIndexes([
      {
        key: { business_id: 1, recipient_contact_hash: 1 },
        name: 'ux_ping_recipient',
        unique: true,
        partialFilterExpression: { is_paid: true },
      },
      {
        key: { business_id: 1, qualifying_user_id: 1 },
        name: 'ux_ping_qualifier',
        unique: true,
        partialFilterExpression: { qualifying_user_id: { $type: 'string' } },
      },
      { key: { sender_user_id: 1, created_at: 1 }, name: 'ix_ping_sender' },
      { key: { device_fingerprint: 1 }, name: 'ix_ping_device' },
    ]);

    await db.collection('gifts').createIndexes([
      { key: { redemption_code: 1 }, name: 'ux_gift_code', unique: true },
      { key: { status: 1, expires_at: 1 }, name: 'ix_gift_expiry' },
    ]);

    await db.collection('giveaways').createIndex({ business_id: 1 }, { name: 'ix_giveaway_business' });
    await db
      .collection('giveaway_claims')
      .createIndex({ giveaway_id: 1, user_id: 1, day_key: 1 }, { name: 'ux_giveaway_claim', unique: true });

    await db.collection('spot_me_requests').createIndexes([
      { key: { requester_id: 1, status: 1 }, name: 'ix_spotme_requester' },
      { key: { status: 1, repay_by: 1 }, name: 'ix_spotme_default' },
    ]);
  },

  async down(db) {
    for (const c of [
      'ping_budgets',
      'pings',
      'gifts',
      'giveaways',
      'giveaway_claims',
      'spot_me_requests',
    ]) {
      await db.collection(c).dropIndexes();
    }
  },
};
