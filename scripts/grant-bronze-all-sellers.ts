/**
 * DEV-ONLY: give every active seller-role holder an approved Bronze verification record, so
 * multi-account consignment testing (checkout:create needs Bronze) works without picking users
 * one by one. Idempotent.
 *
 *   npx tsx scripts/grant-bronze-all-sellers.ts
 */
import { connectMongo, disconnectMongo } from '../src/config/db';
import { UserRoleModel, VerificationRecordModel } from '../src/modules/identity/identity.model';

async function main(): Promise<void> {
  await connectMongo();
  const sellerRoles = await UserRoleModel.find({ role: 'seller', revoked_at: null }).lean().exec();
  for (const r of sellerRoles) {
    await VerificationRecordModel.updateOne(
      { user_id: r.user_id, verification_type: 'id_document' },
      {
        $set: { tier: 'bronze', status: 'approved', verified_at: new Date(), provider: 'dev-script' },
        $setOnInsert: { user_id: r.user_id, verification_type: 'id_document' },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    console.log(`bronze → ${String(r.user_id)}`);
  }
  console.log(`✓ ${sellerRoles.length} seller(s) now Bronze.`);
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
