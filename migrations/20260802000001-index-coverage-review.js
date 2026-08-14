/* eslint-env node */
// Roadmap 5.4 — index coverage review.
//
// Three query shapes were running without any usable index. Found by cross-referencing every
// `find`/`findOne`/`countDocuments` filter in the source against the indexes each model declares,
// then discarding the false positives (a `unique: true` field is already indexed; several schemas
// live in service files rather than `*.model.ts`).
//
// Mongoose creates schema-declared indexes with `autoIndex`, which is off in production — so the
// schema declarations alone would take effect on nobody's cluster. This migration is what actually
// builds them. Both halves exist on purpose: the schema is the documentation, this is the change.
//
// All three are background builds. Foreground index builds block writes on the collection, and two
// of these are on the money and identity paths.
module.exports = {
  async up(db) {
    // 1. KYC webhooks arrive knowing only the provider's reference. This lookup ran as a collection
    //    scan on every callback — cheap today, and the collection only grows.
    //    Partial: most records never receive a provider reference, and indexing thousands of nulls
    //    costs write throughput for a key nobody queries by.
    await db.collection('verification_records').createIndex(
      { provider_reference: 1 },
      {
        name: 'ix_verification_provider_reference',
        background: true,
        partialFilterExpression: { provider_reference: { $type: 'string' } },
      },
    );

    // 2. "My hubs" — the first query every hub-owner screen makes. `hubs` had only its 2dsphere
    //    index, so an owner lookup scanned every hub on the platform.
    await db
      .collection('hubs')
      .createIndex({ owner_user_id: 1 }, { name: 'ix_hubs_owner', background: true });

    // 3. "Postings I made", newest first. `jobs_postings` indexed the public browse shapes
    //    (status+created_at, status+job_type+created_at) but not the poster's own dashboard.
    await db
      .collection('jobs_postings')
      .createIndex(
        { poster_user_id: 1, created_at: -1 },
        { name: 'ix_jobs_poster_recent', background: true },
      );
  },

  async down(db) {
    const drops = [
      ['verification_records', 'ix_verification_provider_reference'],
      ['hubs', 'ix_hubs_owner'],
      ['jobs_postings', 'ix_jobs_poster_recent'],
    ];
    for (const [collection, index] of drops) {
      try {
        await db.collection(collection).dropIndex(index);
      } catch (err) {
        // IndexNotFound (27) — a down that runs twice, or after a partial up, is not a failure.
        if (err.code !== 27) throw err;
      }
    }
  },
};
