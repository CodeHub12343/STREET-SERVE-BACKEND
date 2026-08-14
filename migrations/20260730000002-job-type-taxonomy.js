/* eslint-env node */
// A-5: backfill `job_type` on existing postings and index the browse query.
//
// A Mongoose schema default only applies to documents Mongoose CREATES — every posting already in
// the collection has no `job_type` field at all, so a type filter would silently drop them. The
// service layer tolerates the missing field during the deploy window; this closes it properly.
//
// `sell` is the honest default rather than a placeholder: the pilot's postings were consignment
// selling work, so the value describes them instead of inventing a category. Anything mis-typed is
// a one-field edit by the poster, which is why nothing here tries to be clever about guessing from
// the title — a wrong guess is worse than a known default.
//
// Idempotent: only touches documents that still lack the field.
const DEFAULT_JOB_TYPE = 'sell';

module.exports = {
  async up(db) {
    const postings = db.collection('jobs_postings');

    const result = await postings.updateMany(
      { $or: [{ job_type: { $exists: false } }, { job_type: null }] },
      { $set: { job_type: DEFAULT_JOB_TYPE } },
    );
    if (result.modifiedCount > 0) {
      console.info(`[A-5] backfilled job_type='${DEFAULT_JOB_TYPE}' on ${result.modifiedCount} posting(s)`);
    }

    // Browse is always "open gigs of these types, newest first" — index the whole shape, not the
    // type alone, or the filter still scans every open posting.
    await postings.createIndex(
      { status: 1, job_type: 1, created_at: -1 },
      { name: 'status_1_job_type_1_created_at_-1' },
    );
  },

  async down(db) {
    const postings = db.collection('jobs_postings');
    await postings.dropIndex('status_1_job_type_1_created_at_-1').catch(() => {
      /* index may not exist */
    });
    // Postings explicitly typed as something other than the default keep their type. Rows that read
    // `sell` are indistinguishable from the backfill, so they are unset too — a rollback loses the
    // fact that someone chose the default deliberately. Acceptable: re-running `up` restores the
    // same value, and no money or state depends on this field.
    await postings.updateMany({ job_type: DEFAULT_JOB_TYPE }, { $unset: { job_type: '' } });
  },
};
