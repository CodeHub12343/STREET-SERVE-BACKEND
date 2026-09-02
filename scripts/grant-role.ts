/**
 * ═══ GRANT A ROLE TO A REAL USER — including `admin`. ═══
 *
 * **The lockout this exists to prevent.** `admin` is deliberately not in `SELF_GRANTABLE_ROLES`,
 * and nothing else in the product hands it out. So on a database with no admin in it — a fresh
 * launch, or one whose `users` collection has been cleared — there is no path back in: the first
 * person to sign in is JIT-provisioned as a plain `customer`, and every admin screen (categories,
 * cities, shelter partners, sponsors, RTO approvals, disputes) is unreachable by anybody, for ever.
 *
 * `grant-dev-roles.ts` does not solve this: it is dev-only and grants seller/vendor/hub, never
 * admin. This is the production-safe counterpart, meant to be run once from a server shell.
 *
 *   npx tsx scripts/grant-role.ts --list
 *   npx tsx scripts/grant-role.ts you@example.com admin
 *   npx tsx scripts/grant-role.ts 6a81... admin ops_finance
 *
 * Deliberately a script rather than an endpoint. An HTTP route that grants `admin` is a privilege
 * escalation waiting to be found, however well guarded; a script requires shell access to the
 * server, which is the same bar as reading the database directly.
 *
 * Idempotent: a role the user already holds is reported and skipped, never duplicated.
 */
import { connectMongo, disconnectMongo } from '../src/config/db';
import { ROLES, type Role } from '../src/config/constants';
import { UserModel, UserRoleModel } from '../src/modules/identity/identity.model';

async function listUsers(): Promise<void> {
  const users = await UserModel.find().sort({ created_at: -1 }).limit(20).lean().exec();
  if (users.length === 0) {
    console.log('\nNo users yet. Sign in on the frontend once, then re-run this.\n');
    return;
  }
  console.log('\nUsers (most recent first):\n');
  for (const u of users) {
    const roles = await UserRoleModel.find({ user_id: u._id, revoked_at: null }).lean().exec();
    const held = roles.map((r) => r.role).join(', ') || 'none';
    console.log(`  ${String(u._id)}  ${u.email ?? u.authProviderId}`);
    console.log(`      roles: ${held}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  await connectMongo();
  const [target, ...roles] = process.argv.slice(2);

  if (!target || target === '--list') {
    await listUsers();
    await disconnectMongo();
    return;
  }

  const invalid = roles.filter((r) => !(ROLES as readonly string[]).includes(r));
  if (roles.length === 0 || invalid.length > 0) {
    console.error(
      `\nUsage: npx tsx scripts/grant-role.ts <email|id> <role...>\nValid roles: ${ROLES.join(', ')}\n`,
    );
    process.exitCode = 1;
    await disconnectMongo();
    return;
  }

  /**
   * Matched on the id, the exact email, or an email substring — in that order. A substring match is
   * refused when it hits more than one person: granting `admin` to the wrong account because two
   * addresses shared a prefix is not a mistake worth being convenient about.
   */
  let user = /^[0-9a-f]{24}$/i.test(target)
    ? await UserModel.findById(target).lean().exec()
    : await UserModel.findOne({ email: target }).lean().exec();

  if (!user) {
    const matches = await UserModel.find({ email: new RegExp(target, 'i') }).lean().exec();
    if (matches.length > 1) {
      console.error(`\n"${target}" matches ${matches.length} users. Use the exact email or the id:`);
      for (const m of matches) console.error(`  ${String(m._id)}  ${m.email}`);
      console.error('');
      process.exitCode = 1;
      await disconnectMongo();
      return;
    }
    user = matches[0] ?? null;
  }

  if (!user) {
    console.error(`\nNo user matched "${target}". Run with --list to see who exists.\n`);
    process.exitCode = 1;
    await disconnectMongo();
    return;
  }

  for (const role of roles as Role[]) {
    const existing = await UserRoleModel.findOne({
      user_id: user._id,
      role,
      revoked_at: null,
    }).lean();
    if (existing) {
      console.log(`  = ${role} (already held)`);
      continue;
    }
    await UserRoleModel.create({ user_id: user._id, role, granted_by: 'script:grant-role' });
    console.log(`  + ${role}`);
  }

  console.log(`\nDone — ${user.email ?? String(user._id)}.`);
  // The Principal is built per request from these rows, so it takes effect on the next API call.
  console.log('Sign out and back in on the frontend to pick it up.\n');
  await disconnectMongo();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
