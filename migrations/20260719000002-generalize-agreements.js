/* eslint-env node */
// Generalize agreements (R28 / DEBT7): migrate the bailment-only `seller_agreement_acceptances`
// into the typed `agreement_acceptances` collection (agreement_type='bailment'). These predate
// content-hash capture, so they carry a `legacy:pre-hash` marker — new acceptances store the real
// sha256. Idempotent (upsert by natural key). See PHASE_2_IMPLEMENTATION_PLAN.md §5.
module.exports = {
  async up(db) {
    const legacy = await db.collection('seller_agreement_acceptances').find({}).toArray();
    for (const row of legacy) {
      await db.collection('agreement_acceptances').updateOne(
        { user_id: row.seller_id, agreement_type: 'bailment', version: row.version },
        {
          $setOnInsert: {
            user_id: row.seller_id,
            agreement_type: 'bailment',
            version: row.version,
            content_hash: 'legacy:pre-hash',
            accepted_at: row.accepted_at || new Date(),
          },
        },
        { upsert: true },
      );
    }
  },

  async down(db) {
    // Only remove the rows this migration created (the legacy-marked bailment acceptances).
    await db
      .collection('agreement_acceptances')
      .deleteMany({ agreement_type: 'bailment', content_hash: 'legacy:pre-hash' });
  },
};
