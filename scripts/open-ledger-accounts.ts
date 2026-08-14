/**
 * Phase 1 migration: open zero-balance ledger accounts for the platform and every existing party.
 *
 * Opening accounts up-front is not strictly required — `ledgerService.post()` creates them on
 * demand — but it means the finance dashboards show every party from day one instead of only those
 * who happen to have transacted, and it surfaces the unique-index shape before real money depends
 * on it. Idempotent: `ensureAccount` upserts.
 *
 *   npx tsx scripts/open-ledger-accounts.ts
 */
import { connectMongo, disconnectMongo } from '../src/config/db';
import { UserModel } from '../src/modules/identity/identity.model';
import { BusinessModel } from '../src/modules/vendors/vendors.model';
import { ledgerService } from '../src/modules/ledger/ledger.service';
import type { AccountType } from '../src/modules/ledger/ledger.model';

// Platform books: cash held, fees earned, refund reserve, and losses recognised.
const PLATFORM_ACCOUNTS: AccountType[] = ['cash', 'fee_revenue', 'reserve', 'write_off'];
// A seller is owed money (payable) and can owe money (receivable, from cash sales/losses).
const USER_ACCOUNTS: AccountType[] = ['payable', 'receivable'];
/**
 * A hub business is owed its share, and holds a community fund (ADR-005) once Pay It Forward is
 * enabled for it. The fund account is opened up-front for the same reason as everything else here:
 * so the finance view shows a zero rather than nothing, and so the unique-index shape is exercised
 * before real money depends on it.
 */
const BUSINESS_ACCOUNTS: AccountType[] = ['payable', 'community_fund_payable'];

async function main(): Promise<void> {
  await connectMongo();
  let opened = 0;

  for (const accountType of PLATFORM_ACCOUNTS) {
    await ledgerService.ensureAccount({ ownerType: 'platform', ownerId: null, accountType });
    opened += 1;
  }
  console.log(`platform: ${PLATFORM_ACCOUNTS.length} account(s)`);

  const users = await UserModel.find({}, { _id: 1 }).lean().exec();
  for (const u of users) {
    for (const accountType of USER_ACCOUNTS) {
      await ledgerService.ensureAccount({
        ownerType: 'user',
        ownerId: String(u._id),
        accountType,
      });
      opened += 1;
    }
  }
  console.log(`users: ${users.length} × ${USER_ACCOUNTS.length} account(s)`);

  const businesses = await BusinessModel.find({}, { _id: 1 }).lean().exec();
  for (const b of businesses) {
    for (const accountType of BUSINESS_ACCOUNTS) {
      await ledgerService.ensureAccount({
        ownerType: 'business',
        ownerId: String(b._id),
        accountType,
      });
      opened += 1;
    }
  }
  console.log(`businesses: ${businesses.length} × ${BUSINESS_ACCOUNTS.length} account(s)`);

  console.log(`\n✓ ${opened} ledger account(s) ensured (all at zero).\n`);
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
