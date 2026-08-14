/* eslint-env node */
// Phase 2 indexes: live map (live_sessions, location_pings TTL, follows, notify_me), queue
// (discount_schedules, wave_downs, queues, queue_entries), reviews. See DATABASE_SCHEMA_PLAN.md §3/§4/§8.
const RETENTION_SECONDS = 30 * 24 * 60 * 60;

module.exports = {
  async up(db) {
    await db.collection('live_sessions').createIndexes([
      { key: { current_location: '2dsphere' }, name: 'gx_live_location' },
      { key: { status: 1, last_ping_at: 1 }, name: 'ix_live_status_ping' },
      { key: { actor_type: 1, actor_id: 1 }, name: 'ix_live_actor' },
      { key: { geohash: 1 }, name: 'ix_live_geohash' },
    ]);

    await db
      .collection('location_pings')
      .createIndex({ recorded_at: 1 }, { name: 'ttl_pings', expireAfterSeconds: RETENTION_SECONDS });

    await db.collection('follows').createIndexes([
      { key: { follower_user_id: 1, business_id: 1 }, name: 'ux_follow', unique: true },
      { key: { business_id: 1 }, name: 'ix_follow_business' },
    ]);

    await db
      .collection('notify_me_requests')
      .createIndex({ business_id: 1, status: 1 }, { name: 'ix_notifyme_business' });

    await db
      .collection('discount_schedules')
      .createIndex({ owner_type: 1, owner_id: 1 }, { name: 'ux_discount_owner', unique: true });

    await db.collection('wave_downs').createIndexes([
      { key: { target_id: 1, status: 1, requested_at: 1 }, name: 'ix_wave_target' },
      { key: { customer_id: 1, requested_at: -1 }, name: 'ix_wave_customer' },
      { key: { status: 1, expires_at: 1 }, name: 'ix_wave_sla' },
    ]);

    await db
      .collection('queues')
      .createIndex({ owner_type: 1, owner_id: 1 }, { name: 'ux_queue_owner', unique: true });

    await db.collection('queue_entries').createIndexes([
      { key: { queue_id: 1, joined_at: 1 }, name: 'ix_qentry_order' },
      { key: { customer_id: 1 }, name: 'ix_qentry_customer' },
      { key: { hold_expires_at: 1, left_at: 1 }, name: 'ix_qentry_hold' },
    ]);

    await db.collection('reviews').createIndexes([
      { key: { subject_type: 1, subject_id: 1, created_at: -1 }, name: 'ix_reviews_subject' },
      { key: { transaction_id: 1 }, name: 'ux_reviews_txn', unique: true },
    ]);
  },

  async down(db) {
    for (const c of [
      'live_sessions',
      'location_pings',
      'follows',
      'notify_me_requests',
      'discount_schedules',
      'wave_downs',
      'queues',
      'queue_entries',
      'reviews',
    ]) {
      await db.collection(c).dropIndexes();
    }
  },
};
