/* eslint-env node */
// Phase 3 indexes: scheduling (services, availability_windows, bookings), orders, messaging
// (message_threads, messages). See DATABASE_SCHEMA_PLAN.md §2/§5/§11.
module.exports = {
  async up(db) {
    await db.collection('services').createIndex({ business_id: 1 }, { name: 'ix_services_business' });

    await db
      .collection('availability_windows')
      .createIndex({ business_id: 1, day_of_week: 1 }, { name: 'ix_avail_business_day' });

    await db.collection('bookings').createIndexes([
      { key: { business_id: 1, scheduled_at: 1 }, name: 'ix_bookings_business' },
      { key: { customer_id: 1, scheduled_at: -1 }, name: 'ix_bookings_customer' },
      { key: { status: 1, scheduled_at: 1 }, name: 'ix_bookings_reminders' },
      { key: { service_id: 1, scheduled_at: 1, status: 1 }, name: 'ix_bookings_slots' },
    ]);

    await db.collection('orders').createIndexes([
      { key: { business_id: 1, status: 1 }, name: 'ix_orders_business' },
      { key: { customer_id: 1, created_at: -1 }, name: 'ix_orders_customer' },
    ]);

    await db.collection('message_threads').createIndexes([
      { key: { customer_id: 1, business_id: 1 }, name: 'ux_thread', unique: true },
      { key: { business_id: 1, last_message_at: -1 }, name: 'ix_thread_business' },
    ]);

    await db
      .collection('messages')
      .createIndex({ thread_id: 1, created_at: 1 }, { name: 'ix_messages_thread' });
  },

  async down(db) {
    for (const c of [
      'services',
      'availability_windows',
      'bookings',
      'orders',
      'message_threads',
      'messages',
    ]) {
      await db.collection(c).dropIndexes();
    }
  },
};
