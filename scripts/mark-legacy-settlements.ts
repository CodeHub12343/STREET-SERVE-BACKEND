/**
 * Phase 0 migration: mark every settlement written BEFORE the solvency guard as `legacy_unfunded`.
 *
 * These rows were created when settlement transferred money regardless of whether the platform had
 * collected anything, so their payout refs describe platform capital spent on uncollected sales.
 * They are deliberately NOT back-filled or reversed: the ledger (Phase 1) starts from a clean,
 * stated date, and inventing inbound funds to make old rows balance would corrupt the first thing
 * the new books say.
 *
 * Per-leg status is inferred from the payout refs that already exist:
 *   ref present → 'paid'  (money really did leave the platform)
 *   owed, no ref → 'no_account'  (the payee had no payout-enabled account)
 *   nothing owed → 'not_applicable'
 *
 * Idempotent: only touches rows without a `funding_source`.
 *
 *   npx tsx scripts/mark-legacy-settlements.ts          # dry run
 *   npx tsx scripts/mark-legacy-settlements.ts --apply  # write
 */
import { connectMongo, disconnectMongo } from '../src/config/db';
import { SettlementModel } from '../src/modules/consignment/consignment.model';
import { formatCents } from '../src/shared/money';

type LegStatus = 'paid' | 'awaiting_funds' | 'no_account' | 'not_applicable';

function legStatus(amountCents: number, payoutRef: string | null | undefined): LegStatus {
  if (amountCents <= 0) return 'not_applicable';
  return payoutRef ? 'paid' : 'no_account';
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await connectMongo();

  // `funding_source` has a schema default, so target rows where it was never persisted.
  const legacy = await SettlementModel.find({ funding_source: { $exists: false } })
    .lean()
    .exec();

  if (legacy.length === 0) {
    console.log('\nNo un-migrated settlements found — nothing to do.\n');
    return;
  }

  console.log(`\n${legacy.length} legacy settlement(s) to mark:\n`);
  let realMoneyOut = 0;

  for (const s of legacy) {
    const sellerStatus = legStatus(s.seller_net_cents, s.seller_payout_ref);
    const hubStatus = legStatus(s.hub_share_cents, s.hub_payout_ref);
    if (s.seller_payout_ref) realMoneyOut += s.seller_net_cents;
    if (s.hub_payout_ref) realMoneyOut += s.hub_share_cents;

    console.log(
      `  checkout=${s.checkout_id}\n` +
        `      gross=${formatCents(s.gross_sales_cents)}  ` +
        `seller=${formatCents(s.seller_net_cents)} [${sellerStatus}]  ` +
        `hub=${formatCents(s.hub_share_cents)} [${hubStatus}]`,
    );

    if (apply) {
      // `immutablePlugin` blocks Mongoose updates on settlements by design. This one-time
      // classification adds provenance metadata only — no financial figure is altered — so it
      // goes through the raw driver deliberately. Do NOT copy this pattern into application code.
      await SettlementModel.collection.updateOne(
        { _id: s._id },
        {
          $set: {
            funding_source: 'legacy_unfunded',
            collected_cents: 0, // nothing was ever collected for these
            seller_payout_status: sellerStatus,
            hub_payout_status: hubStatus,
          },
        },
      );
    }
  }

  console.log(
    `\nPlatform capital actually disbursed against uncollected sales: ${formatCents(realMoneyOut)}`,
  );
  console.log(
    apply
      ? `\n✓ Marked ${legacy.length} settlement(s) as legacy_unfunded.\n`
      : '\n(dry run — re-run with --apply to write)\n',
  );
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
