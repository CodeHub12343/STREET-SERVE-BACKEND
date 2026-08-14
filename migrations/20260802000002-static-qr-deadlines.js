/* eslint-env node */
// Roadmap 6.5 — put a deadline on every grandfathered static hub QR.
//
// `allow_static_qr` was grandfathering for hubs that had already printed the pre-rotation poster.
// The intent was to chase them down and switch them off; nothing in the code made that happen, so
// it was a permanent exception with a temporary name. Every hub still on it can be defeated by
// anyone who photographed the poster once — which defeats the only proof of physical presence in
// the custody model.
//
// This sets a per-hub deadline on the ones that are still open. It does NOT switch anyone off
// today: a hub whose check-ins stop working without warning breaks for a seller standing at the
// counter, not for the owner who ignored the change. The application layer additionally caps every
// hub at `STATIC_QR_SUNSET_AT`, so a hub cannot outlive the sunset even if this migration never ran
// or its deadline was edited outward.
const GRACE_DAYS = 30;

module.exports = {
  async up(db) {
    const deadline = new Date(Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000);

    const result = await db.collection('hubs').updateMany(
      { allow_static_qr: true, $or: [{ static_qr_deadline_at: null }, { static_qr_deadline_at: { $exists: false } }] },
      { $set: { static_qr_deadline_at: deadline } },
    );

    if (result.modifiedCount > 0) {
      console.info(
        `[6.5] ${result.modifiedCount} hub(s) still accept the static printed QR. ` +
          `Deadline set to ${deadline.toISOString().slice(0, 10)}. ` +
          `Move them to the station screen before then: npx tsx scripts/static-qr-phaseout.ts`,
      );
    } else {
      console.info('[6.5] No hubs are on the static QR — nothing to deadline.');
    }

    // The deadline sweep and the ops report both query by it.
    await db
      .collection('hubs')
      .createIndex(
        { allow_static_qr: 1, static_qr_deadline_at: 1 },
        { name: 'ix_hubs_static_qr_deadline', background: true },
      );
  },

  async down(db) {
    await db
      .collection('hubs')
      .updateMany({ static_qr_deadline_at: { $ne: null } }, { $set: { static_qr_deadline_at: null } });
    try {
      await db.collection('hubs').dropIndex('ix_hubs_static_qr_deadline');
    } catch (err) {
      if (err.code !== 27) throw err; // IndexNotFound
    }
  },
};
