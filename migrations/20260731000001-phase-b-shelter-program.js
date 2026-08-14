/* eslint-env node */
// Phase B — make the shelter program real.
//
// Three things happen here, in order of how badly they were needed:
//
// 1. EXISTING ENROLLMENTS GET A STATUS. Every row predates the invite/claim lifecycle, and they are
//    all live residents — so they become `active`, not `invited`. Getting this backwards would
//    silently strip selling rights from everyone already in the program.
//
// 2. THE UNIQUE INDEX IS REBUILT AS PARTIAL. `{shelter_partner_id, resident_user_id}` was plainly
//    unique, which is fine while every enrollment has a resident — but an unclaimed invite has
//    `resident_user_id: null`, and a plain unique index permits only ONE null per partner. A
//    shelter could have exactly one invite outstanding at a time. The partial filter restricts
//    uniqueness to rows where the resident actually exists.
//
// 3. INDEXES for the new custody and training collections.
//
// Idempotent throughout.
module.exports = {
  async up(db) {
    const enrollments = db.collection('shelter_enrollments');

    // 1. Backfill lifecycle fields on rows written before Phase B.
    const backfilled = await enrollments.updateMany(
      { status: { $exists: false } },
      {
        $set: {
          status: 'active',
          // These residents were enrolled directly, so they were claimed the moment they were created.
          claimed_at: new Date(),
          claim_code: null,
          claim_expires_at: null,
          training_completed_at: null,
          training_score_percent: null,
          starter_grant_used: 0,
          exited_at: null,
          exit_reason: null,
        },
      },
    );
    if (backfilled.modifiedCount > 0) {
      console.info(`[B] marked ${backfilled.modifiedCount} existing enrollment(s) active`);
    }

    /**
     * NOTE ON TRAINING: existing residents are left with `training_completed_at: null`, which means
     * the B-5 gate will ask them to complete the starter course before their next pickup. That is
     * deliberate — the course covers the return window and what a cash sale costs them, and nobody
     * currently in the program has ever been told either. A few minutes now is the right trade.
     */

    // 2. Replace the plain unique index with a partial one.
    try {
      await enrollments.dropIndex('shelter_partner_id_1_resident_user_id_1');
    } catch {
      /* already dropped, or never created under that name */
    }
    await enrollments.createIndex(
      { shelter_partner_id: 1, resident_user_id: 1 },
      {
        unique: true,
        partialFilterExpression: { resident_user_id: { $type: 'string' } },
        name: 'shelter_partner_id_1_resident_user_id_1',
      },
    );
    await enrollments.createIndex({ resident_user_id: 1, status: 1 });
    await enrollments.createIndex({ claim_code: 1 });

    // Partners default to custody OFF — it is a fiduciary duty, and nobody is opted into one.
    await db
      .collection('shelter_partners')
      .updateMany({ custody_enabled: { $exists: false } }, { $set: { custody_enabled: false } });
    await db.collection('shelter_partners').createIndex({ location: '2dsphere' });

    // 3. New collections.
    const custody = db.collection('shelter_custody');
    await custody.createIndex({ shelter_partner_id: 1, status: 1, created_at: -1 });
    await custody.createIndex({ resident_user_id: 1 });
    // One custody row per payout leg — a retried webhook must not double-earmark.
    await custody.createIndex({ source_type: 1, source_ref_id: 1 }, { unique: true });

    const training = db.collection('training_completions');
    await training.createIndex({ user_id: 1, course_slug: 1, completed_at: -1 });

    // B-4: find grant-covered checkouts without scanning.
    await db
      .collection('inventory_checkouts')
      .createIndex({ starter_grant_partner_id: 1 }, { sparse: true });
  },

  async down(db) {
    const enrollments = db.collection('shelter_enrollments');
    try {
      await enrollments.dropIndex('shelter_partner_id_1_resident_user_id_1');
    } catch {
      /* not present */
    }
    // Restore the plain unique index. Any unclaimed invites must go first or this cannot build.
    await enrollments.deleteMany({ status: 'invited', resident_user_id: null });
    await enrollments.createIndex(
      { shelter_partner_id: 1, resident_user_id: 1 },
      { unique: true, name: 'shelter_partner_id_1_resident_user_id_1' },
    );
    await enrollments.updateMany(
      {},
      {
        $unset: {
          status: '',
          claim_code: '',
          claim_expires_at: '',
          claimed_at: '',
          training_completed_at: '',
          training_score_percent: '',
          starter_grant_used: '',
          exited_at: '',
          exit_reason: '',
        },
      },
    );
    // Custody and training rows are deliberately NOT dropped: they record money that moved and
    // obligations people were told about. A schema rollback is not a reason to lose that.
  },
};
