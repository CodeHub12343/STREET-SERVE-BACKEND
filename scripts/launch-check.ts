/**
 * ═══ IS THIS DATABASE READY TO TAKE REAL USERS? ═══
 *
 * Written for the launch reset: the whole database is wiped so the platform starts clean, and the
 * only question left is whether the CONFIGURATION the app needs to function survived.
 *
 * Almost every collection is user or transaction data and should be empty on day one. Exactly three
 * hold reference data the product cannot work without, and one is migrate-mongo's own bookkeeping.
 * Wiping any of those four looks identical to a successful reset until something fails in front of
 * a real user — an empty `cities` silently disables Rent-to-Own everywhere, and a wiped changelog
 * makes the next deploy re-run migrations that will fail on indexes that already exist.
 *
 *   npx tsx scripts/launch-check.ts
 *
 * Read-only. Exits non-zero if anything would block launch, so it can gate a release.
 */
import { connectMongo, disconnectMongo, mongoose } from '../src/config/db';
import { CategoryModel, CityModel, FeeScheduleModel } from '../src/modules/catalog/catalog.model';
import { UserModel, UserRoleModel } from '../src/modules/identity/identity.model';

const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);
const warn = (m: string) => console.log(`  ! ${m}`);

async function main(): Promise<void> {
  await connectMongo();
  const db = mongoose.connection.db;
  if (!db) throw new Error('no active mongo connection');
  let blocking = 0;

  console.log('\n─── configuration the app needs ───');

  const categories = await CategoryModel.estimatedDocumentCount();
  if (categories > 0) ok(`categories: ${categories}`);
  else {
    bad('categories: EMPTY — businesses cannot be created. Run: npm run seed');
    blocking += 1;
  }

  const cities = await CityModel.find().lean().exec();
  if (cities.length > 0) {
    ok(`cities: ${cities.length}`);
    /**
     * Listed individually because the flags are the actual launch switches, and their defaults
     * differ: RTO is default-DENY (absent flag = off everywhere) while delivery is default-ALLOW
     * (only an explicit `false` closes it). A city row existing is not the same as a city being open.
     */
    for (const c of cities) {
      const f = (c.feature_flags ?? {}) as Record<string, unknown>;
      const rto = f.rto === true ? 'rto ON' : 'rto off';
      const delivery = f.delivery === false ? 'delivery OFF' : 'delivery on';
      console.log(`      ${c.slug} (${c.status}) — ${rto}, ${delivery}`);
    }
    if (!cities.some((c) => c.status === 'live')) {
      warn('no city is `live` — check the launch city before going public');
    }
  } else {
    bad('cities: EMPTY — Rent-to-Own is disabled everywhere. Run: npm run seed');
    blocking += 1;
  }

  const fees = await FeeScheduleModel.estimatedDocumentCount();
  if (fees > 0) ok(`fee_schedule: ${fees} version(s)`);
  else {
    // Not blocking: `resolveFeeRule` falls back to DEFAULT_FEE_RULES in code, so nothing charges
    // zero. But any rate tuned in the database is gone, and that is worth knowing before launch.
    warn('fee_schedule: EMPTY — falling back to code defaults. Run: npm run seed to restore');
  }

  const applied = await db.collection('migrations_changelog').countDocuments();
  if (applied > 0) ok(`migrations_changelog: ${applied} applied`);
  else {
    bad('migrations_changelog: EMPTY — the next deploy will re-run every migration and fail');
    blocking += 1;
  }

  console.log('\n─── access ───');

  const users = await UserModel.estimatedDocumentCount();
  const admins = await UserRoleModel.countDocuments({ role: 'admin', revoked_at: null });
  console.log(`  users: ${users}`);
  if (admins > 0) ok(`admin roles: ${admins}`);
  else {
    /**
     * `admin` is not self-grantable and no endpoint hands it out, so a database with no admin has
     * no way back in — every admin screen is unreachable by everybody, permanently.
     */
    bad('NO ADMIN — sign in once, then: npm run grant-role -- <email> admin');
    blocking += 1;
  }

  /**
   * Role rows outlive the users they point at. After a wipe that clears `users` but not
   * `user_roles`, the leftovers are inert — the Principal is built from the NEW user's id — but they
   * are dead rows that will confuse the next person who reads this collection.
   */
  const roles = await UserRoleModel.find().lean().exec();
  let orphanRoles = 0;
  for (const r of roles) {
    if (!(await UserModel.exists({ _id: r.user_id }))) orphanRoles += 1;
  }
  if (orphanRoles > 0) {
    warn(`${orphanRoles} user_roles row(s) point at deleted users — safe to delete`);
  } else if (roles.length > 0) {
    ok('no orphaned user_roles');
  }

  console.log(
    blocking === 0
      ? '\n✓ Ready to launch.\n'
      : `\n✗ ${blocking} blocking issue(s) — see above.\n`,
  );
  await disconnectMongo();
  if (blocking > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
