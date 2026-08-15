/* eslint-env node */
/**
 * Create the indexes that no migration ever created.
 *
 * ## How they went missing
 *
 * Mongoose `autoIndex` built these at boot, so every environment had them and nobody noticed the
 * migrations did not. Disabling autoIndex (indexes are migrations, not a boot side effect —
 * DEPLOYMENT_STRATEGY.md §7) made the omission real: `events` lost its 2dsphere index and every
 * `GET /events/nearby` returned 500, "unable to find index for $geoNear query". The map's event
 * layer was down and the cause was a gap in this directory, not in the query.
 *
 * ## Why they are declared here rather than left to the schema
 *
 * An index that exists only in a Mongoose schema is invisible to a fresh deployment. It appears the
 * moment something happens to connect with autoIndex on, and disappears the moment nothing does —
 * which is not a deployment strategy, it is luck. `scripts/index-audit.ts` reports drift of exactly
 * this kind; this migration closes the instances it found.
 *
 * `createIndex` is idempotent for an identical spec, so this is safe on an environment that already
 * has them (as staging does, having had them recreated by accident).
 */
module.exports = {
  async up(db) {
    /**
     * E-4 nearby events. The 2dsphere is the one whose absence broke the map; the others are the
     * rest of the collection's schema-declared set, which went the same way for the same reason.
     */
    await db.collection('events').createIndexes([
      { key: { location: '2dsphere' }, name: 'location_2dsphere' },
      { key: { starts_at: 1 }, name: 'starts_at_1' },
      /** The hot query: upcoming, not cancelled. */
      { key: { starts_at: 1, cancelled: 1 }, name: 'starts_at_1_cancelled_1' },
      /**
       * Idempotent ingestion — one row per upstream event, while manual rows (no `source_ref`) stay
       * unconstrained. The UNIQUE and the partial filter are part of the index's identity: created
       * without them, this is a different index wearing the same name, and MongoDB rejects it.
       */
      {
        key: { source: 1, source_ref: 1 },
        name: 'source_1_source_ref_1',
        unique: true,
        partialFilterExpression: { source_ref: { $type: 'string' } },
      },
    ]);

    /**
     * R28 — "has this user accepted this version of this agreement?" is the read behind every gated
     * action (going live, uploading postcard artwork).
     *
     * UNIQUE is the point, not an optimisation: one acceptance row per (user, agreement, version),
     * so a double submit cannot record the same consent twice.
     */
    await db
      .collection('agreement_acceptances')
      .createIndex(
        { user_id: 1, agreement_type: 1, version: 1 },
        { name: 'user_id_1_agreement_type_1_version_1', unique: true },
      );

  },

  async down(db) {
    const drop = async (collection, name) => {
      try {
        await db.collection(collection).dropIndex(name);
      } catch (err) {
        // 27 = IndexNotFound. Anything else is a real problem and should surface.
        if (err.code !== 27 && !/index not found/i.test(err.message ?? '')) throw err;
      }
    };

    await drop('events', 'location_2dsphere');
    await drop('events', 'starts_at_1');
    await drop('events', 'starts_at_1_cancelled_1');
    await drop('events', 'source_1_source_ref_1');
    await drop('agreement_acceptances', 'user_id_1_agreement_type_1_version_1');
  },
};
