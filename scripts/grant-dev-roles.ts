/**
 * DEV-ONLY: grant the most-recently-created user the seller/vendor/hub roles + a Bronze verification
 * tier, so the full consignment flow (hub register → products → seller reserve → checkout → settle)
 * is testable locally. The `hub` role has no onboarding UI path, hence this helper. Idempotent.
 *
 *   npx tsx scripts/grant-dev-roles.ts             # targets the most recent user
 *   npx tsx scripts/grant-dev-roles.ts <email|id>  # targets a specific user (email substring ok)
 */
import { connectMongo, disconnectMongo } from '../src/config/db';
import {
  UserModel,
  UserRoleModel,
  VerificationRecordModel,
} from '../src/modules/identity/identity.model';

const ROLES_TO_GRANT = ['seller', 'vendor', 'hub'] as const;

async function main(): Promise<void> {
  await connectMongo();

  const users = await UserModel.find().sort({ created_at: -1 }).limit(10).lean().exec();
  if (users.length === 0) {
    console.log('No users found — sign in on the frontend first, then re-run.');
    return;
  }

  console.log(`\nUsers (most recent first):`);
  for (const u of users) {
    const roles = await UserRoleModel.find({ user_id: u._id, revoked_at: null }).lean().exec();
    console.log(
      `  ${String(u._id)}  ${u.email ?? u.display_name ?? '(no email)'}  roles=[${roles
        .map((r) => r.role)
        .join(', ')}]`,
    );
  }

  const arg = process.argv[2]?.trim().toLowerCase();
  const target = arg
    ? users.find(
        (u) => String(u._id) === arg || (u.email ?? '').toLowerCase().includes(arg),
      )
    : users[0];
  if (!target) {
    console.log(`\nNo user matching "${arg}" in the ${users.length} most recent — see list above.`);
    return;
  }
  console.log(`\n→ Granting roles to: ${target.email ?? String(target._id)}`);

  for (const role of ROLES_TO_GRANT) {
    await UserRoleModel.updateOne(
      { user_id: target._id, role, revoked_at: null },
      { $setOnInsert: { user_id: target._id, role, granted_by: 'dev-script', granted_at: new Date() } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  }

  // Bronze tier (checkout:create needs it) via an approved verification record.
  await VerificationRecordModel.updateOne(
    { user_id: target._id, verification_type: 'id_document' },
    {
      $set: { tier: 'bronze', status: 'approved', verified_at: new Date(), provider: 'dev-script' },
      $setOnInsert: { user_id: target._id, verification_type: 'id_document' },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  const finalRoles = await UserRoleModel.find({ user_id: target._id, revoked_at: null }).lean().exec();
  console.log(`✓ Done. Active roles now: [${finalRoles.map((r) => r.role).join(', ')}] + Bronze tier.`);
  console.log('  Refresh the browser (hard reload) to pick up the new roles.\n');
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
