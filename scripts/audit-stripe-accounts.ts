/**
 * ═══ WHAT SURVIVED IN STRIPE THAT THE DATABASE NO LONGER KNOWS ABOUT. ═══
 *
 * `connected_accounts` maps (owner_type, owner_id) → a Stripe Connect account. Wipe that collection
 * and the mapping is gone from OUR side — but the accounts still exist at Stripe, with real bank
 * details attached and possibly a real balance. Nothing in the product will ever look at them
 * again: `ensureConnectedAccount` finds no row, creates a BRAND NEW account, and the old one is
 * orphaned in place.
 *
 * `inspect-payouts.ts` cannot answer this, because it reads the very rows that are missing. This
 * reads STRIPE and reconciles the other way: for every Connect account the platform has ever
 * created, does our database still know who it belongs to?
 *
 *   npx tsx scripts/audit-stripe-accounts.ts
 *
 * Read-only. It creates nothing, changes nothing, and moves no money — the point is to see what is
 * stranded before deciding what to do about it.
 */
import Stripe from 'stripe';

import { connectMongo, disconnectMongo } from '../src/config/db';
import { env } from '../src/config/env';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { UserModel } from '../src/modules/identity/identity.model';
import { BusinessModel } from '../src/modules/vendors/vendors.model';

async function main(): Promise<void> {
  if (!env.STRIPE_SECRET_KEY) {
    console.error('\nSTRIPE_SECRET_KEY is not set — nothing to audit.\n');
    process.exitCode = 1;
    return;
  }
  /**
   * Stated first and loudly. On test keys every finding below is noise: test accounts hold no real
   * money and orphaning them costs nothing. On live keys the same output is a list of real bank
   * connections, and possibly real balances, that the platform can no longer reach.
   */
  const live = env.STRIPE_SECRET_KEY.startsWith('sk_live');
  console.log(`\n═══ Stripe mode: ${live ? 'LIVE — real money' : 'TEST — no real money'} ═══\n`);

  await connectMongo();
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);

  const orphans: { id: string; ownerType?: string; ownerId?: string; reason: string }[] = [];
  let total = 0;
  let healthy = 0;

  for await (const acct of stripe.accounts.list({ limit: 100 })) {
    total += 1;
    const ownerType = acct.metadata?.ownerType;
    const ownerId = acct.metadata?.ownerId;

    // Our row is the thing that makes an account reachable at all.
    const row = await ConnectedAccountModel.findOne({ stripe_account_id: acct.id }).lean().exec();
    if (row) {
      healthy += 1;
      continue;
    }

    /**
     * No row. Whether that is recoverable depends entirely on whether the OWNER still exists —
     * the metadata records who it was, but an id pointing at a deleted user or business cannot be
     * re-linked to anything.
     */
    let reason = 'no connected_accounts row';
    if (!ownerType || !ownerId) {
      reason = 'no owner metadata — cannot be re-linked';
    } else {
      const owner =
        ownerType === 'business'
          ? await BusinessModel.findById(ownerId).lean().exec()
          : await UserModel.findById(ownerId).lean().exec();
      reason = owner
        ? 'RE-LINKABLE — owner still exists, row can be recreated'
        : `owner ${ownerType}:${ownerId} no longer exists — permanently orphaned`;
    }
    orphans.push({ id: acct.id, ownerType, ownerId, reason });
  }

  console.log(`Connect accounts at Stripe: ${total}`);
  console.log(`  linked to a database row:  ${healthy}`);
  console.log(`  orphaned:                  ${orphans.length}\n`);

  if (orphans.length === 0) {
    console.log('Nothing stranded.\n');
    await disconnectMongo();
    return;
  }

  /**
   * The balance is the only part that actually matters. An orphaned account with nothing in it is
   * clutter; one holding money is a person who cannot be paid, and no amount of re-onboarding
   * releases it — the funds sit in the account the platform can no longer see.
   */
  console.log('─── orphaned accounts ───');
  let strandedCents = 0;
  for (const o of orphans) {
    let balanceNote = '';
    try {
      const bal = await stripe.balance.retrieve({ stripeAccount: o.id });
      const cents =
        [...bal.available, ...bal.pending].reduce((sum, b) => sum + b.amount, 0) ?? 0;
      strandedCents += cents;
      balanceNote = cents > 0 ? `  ⚠ BALANCE ${(cents / 100).toFixed(2)}` : '  (empty)';
    } catch {
      balanceNote = '  (balance unreadable)';
    }
    console.log(`  ${o.id}${balanceNote}`);
    console.log(`      ${o.reason}`);
  }

  console.log(`\nTotal stranded across orphaned accounts: ${(strandedCents / 100).toFixed(2)}`);
  if (strandedCents > 0 && live) {
    console.log(
      '\n⚠ Real money is sitting in accounts the platform can no longer reach. Re-onboarding does\n' +
        '  NOT release it — it creates a different account. Move it from the Stripe dashboard, or\n' +
        '  recreate the connected_accounts row by hand if the owner still exists.\n',
    );
  }
  await disconnectMongo();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
