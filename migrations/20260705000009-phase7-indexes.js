/* eslint-env node */
// Phase 7 indexes: jobs (jobs_postings, job_applications) + shelter (shelter_partners,
// shelter_enrollments). See DATABASE_SCHEMA_PLAN.md §3.
module.exports = {
  async up(db) {
    await db.collection('jobs_postings').createIndexes([
      { key: { location: '2dsphere' }, name: 'gx_jobs_location' },
      { key: { status: 1, created_at: -1 }, name: 'ix_jobs_status' },
    ]);
    await db.collection('job_applications').createIndexes([
      { key: { job_id: 1, applicant_id: 1 }, name: 'ux_job_app', unique: true },
      { key: { applicant_id: 1, status: 1 }, name: 'ix_job_app_applicant' },
    ]);

    await db.collection('shelter_partners').createIndex({ owner_user_id: 1 }, { name: 'ix_shelter_owner' });
    await db
      .collection('shelter_enrollments')
      .createIndex({ shelter_partner_id: 1, resident_user_id: 1 }, { name: 'ux_shelter_enroll', unique: true });
  },

  async down(db) {
    for (const c of ['jobs_postings', 'job_applications', 'shelter_partners', 'shelter_enrollments']) {
      await db.collection(c).dropIndexes();
    }
  },
};
