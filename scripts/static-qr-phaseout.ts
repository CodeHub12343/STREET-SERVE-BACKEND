/**
 * Roadmap 6.5 — drive the static hub QR to zero.
 *
 * Replaces `grandfather-static-qr.ts`, which could only grant the exception and revoke it one hub at
 * a time. Granting was never the hard part. This reports on the exception, shows who is still
 * *using* it (from the audit trail, not from the flag), and closes it.
 *
 *   npx tsx scripts/static-qr-phaseout.ts                  # report: who is still open, and who still uses it
 *   npx tsx scripts/static-qr-phaseout.ts --revoke <hubId> # switch one hub off now
 *   npx tsx scripts/static-qr-phaseout.ts --revoke-unused  # switch off every hub with no static use in 30 days
 *   npx tsx scripts/static-qr-phaseout.ts --revoke-all     # switch every hub off (the end state)
 *
 * `--revoke-unused` is the one to reach for first: a hub that has not used the printed poster in a
 * month is not relying on it, so turning it off costs nobody anything and shrinks the exposure now
 * rather than on the deadline.
 */
import { connectMongo, disconnectMongo } from '../src/config/db';
import { STATIC_QR_SUNSET_AT } from '../src/config/constants';
import { AuditLogModel } from '../src/shared/audit';
import { HubModel } from '../src/modules/consignment/consignment.model';
import {
  staticQrDaysRemaining,
  staticQrExpiresAt,
} from '../src/modules/consignment/staticQrSunset';

const UNUSED_WINDOW_DAYS = 30;

async function revoke(hubIds: string[]): Promise<void> {
  const res = await HubModel.updateMany(
    { _id: { $in: hubIds } },
    { $set: { allow_static_qr: false, static_qr_deadline_at: null } },
  ).exec();
  console.log(`\n✓ ${res.modifiedCount} hub(s) now require the rotating code. Old posters are dead.\n`);
}

async function main(): Promise<void> {
  await connectMongo();
  const argv = process.argv;

  const open = await HubModel.find({ allow_static_qr: true }).lean().exec();
  if (open.length === 0) {
    console.log('\n✔ No hub accepts the static printed QR. The phase-out is complete.\n');
    return;
  }

  // Who is actually USING it — the flag says who is permitted, the audit trail says who depends on
  // it. Those are different sets, and only the second one costs anything to switch off.
  const since = new Date(Date.now() - UNUSED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const recentUse = await AuditLogModel.aggregate<{ _id: string; count: number; last: Date }>([
    { $match: { action: 'hub.static_qr_used', created_at: { $gte: since } } },
    { $group: { _id: '$entityId', count: { $sum: 1 }, last: { $max: '$created_at' } } },
  ]).exec();
  const useByHub = new Map(recentUse.map((r) => [r._id, r]));

  const revokeIdx = argv.indexOf('--revoke');
  if (revokeIdx !== -1) {
    const hubId = argv[revokeIdx + 1];
    if (!hubId) {
      console.log('\nUsage: --revoke <hubId>\n');
      return;
    }
    await revoke([hubId]);
    return;
  }
  if (argv.includes('--revoke-all')) {
    await revoke(open.map((h) => String(h._id)));
    return;
  }
  if (argv.includes('--revoke-unused')) {
    const unused = open.filter((h) => !useByHub.has(String(h._id))).map((h) => String(h._id));
    if (unused.length === 0) {
      console.log(`\nEvery open hub used the static code in the last ${UNUSED_WINDOW_DAYS} days.\n`);
      return;
    }
    await revoke(unused);
    return;
  }

  console.log(`\n${open.length} hub(s) still accept the static printed QR.`);
  console.log(`Platform sunset: ${STATIC_QR_SUNSET_AT.toISOString().slice(0, 10)} — no hub outlives it.\n`);
  console.log('  hub                        days left   uses (30d)   last use     address');
  console.log('  ─────────────────────────  ─────────   ──────────   ──────────   ───────');
  for (const hub of open) {
    const id = String(hub._id);
    const use = useByHub.get(id);
    console.log(
      `  ${id}   ${String(staticQrDaysRemaining(hub) ?? '-').padStart(9)}   ` +
        `${String(use?.count ?? 0).padStart(10)}   ` +
        `${(use?.last?.toISOString().slice(0, 10) ?? '     never').padStart(10)}   ` +
        `${hub.address ?? '(no address)'}`,
    );
  }

  const unusedCount = open.filter((h) => !useByHub.has(String(h._id))).length;
  console.log(
    `\n⚠ Each open hub is one photographed poster away from remote stock reservation.` +
      (unusedCount > 0
        ? `\n  ${unusedCount} of them have not used it in ${UNUSED_WINDOW_DAYS} days — those cost nothing to close:` +
          `\n      npx tsx scripts/static-qr-phaseout.ts --revoke-unused\n`
        : '\n'),
  );
  const expiring = open.filter((h) => (staticQrDaysRemaining(h) ?? 99) <= 14);
  if (expiring.length > 0) {
    console.log(
      `  ${expiring.length} hub(s) lose static acceptance within 14 days` +
        ` (earliest ${expiring
          .map((h) => staticQrExpiresAt(h)?.toISOString().slice(0, 10))
          .sort()[0]}). Confirm they are on the station screen.\n`,
    );
  }
}

main()
  .then(async () => {
    await disconnectMongo();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await disconnectMongo().catch(() => {});
    process.exit(1);
  });
