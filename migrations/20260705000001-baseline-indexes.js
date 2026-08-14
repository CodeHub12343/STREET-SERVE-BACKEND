/* eslint-env node */
// Baseline indexes for the Phase 0 collections. Index creation is explicit and reviewable here
// rather than implicit at runtime in production. Mirrors DATABASE_SCHEMA_PLAN.md §13.
module.exports = {
  async up(db) {
    // users
    await db.collection('users').createIndexes([
      { key: { authProviderId: 1 }, name: 'ux_users_authProviderId', unique: true },
      // Partial (not sparse): sparse indexes explicit null values, which collide across users
      // without an email/phone. Partial-on-$type:'string' indexes only real values.
      {
        key: { email: 1 },
        name: 'ux_users_email',
        unique: true,
        partialFilterExpression: { email: { $type: 'string' } },
      },
      {
        key: { phone: 1 },
        name: 'ux_users_phone',
        unique: true,
        partialFilterExpression: { phone: { $type: 'string' } },
      },
      { key: { home_location: '2dsphere' }, name: 'gx_users_home_location' },
      { key: { status: 1 }, name: 'ix_users_status' },
    ]);

    // user_roles — one active grant per (user, role)
    await db.collection('user_roles').createIndexes([
      {
        key: { user_id: 1, role: 1 },
        name: 'ux_user_roles_active',
        unique: true,
        partialFilterExpression: { revoked_at: null },
      },
      { key: { user_id: 1 }, name: 'ix_user_roles_user' },
    ]);

    // verification_records
    await db.collection('verification_records').createIndexes([
      { key: { user_id: 1, verification_type: 1 }, name: 'ix_ver_user_type' },
      { key: { status: 1 }, name: 'ix_ver_status' },
      { key: { provider_reference: 1 }, name: 'ix_ver_provider_ref' },
    ]);

    // categories
    await db.collection('categories').createIndexes([
      { key: { slug: 1 }, name: 'ux_categories_slug', unique: true },
      { key: { top_level_tab: 1 }, name: 'ix_categories_tab' },
      { key: { parent_category_id: 1 }, name: 'ix_categories_parent' },
    ]);

    // cities
    await db
      .collection('cities')
      .createIndex({ slug: 1 }, { name: 'ux_cities_slug', unique: true });

    // fee_schedule
    await db
      .collection('fee_schedule')
      .createIndex({ version: 1 }, { name: 'ux_fee_version', unique: true });

    // audit_logs (immutable, append-only)
    await db.collection('audit_logs').createIndexes([
      { key: { entityType: 1, entityId: 1, created_at: -1 }, name: 'ix_audit_entity' },
      { key: { actorId: 1, created_at: -1 }, name: 'ix_audit_actor' },
      { key: { action: 1, created_at: -1 }, name: 'ix_audit_action' },
    ]);
  },

  async down(db) {
    await db.collection('users').dropIndexes();
    await db.collection('user_roles').dropIndexes();
    await db.collection('verification_records').dropIndexes();
    await db.collection('categories').dropIndexes();
    await db.collection('cities').dropIndexes();
    await db.collection('fee_schedule').dropIndexes();
    await db.collection('audit_logs').dropIndexes();
  },
};
