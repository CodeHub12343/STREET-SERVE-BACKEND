/**
 * DEV-ONLY: report the payout readiness of every connected account, plus what the settlements
 * ledger actually disbursed. Answers "did money really move, or only on paper?".
 *
 *   npx tsx scripts/inspect-payouts.ts
 */
import { connectMongo, disconnectMongo } from '../src/config/db';
import { ConnectedAccountModel } from '../src/modules/payments/payments.model';
import { SettlementModel } from '../src/modules/consignment/consignment.model';
import { UserModel } from '../src/modules/identity/identity.model';

async function main(): Promise<void> {
  await connectMongo();

  const accounts = await ConnectedAccountModel.find().lean().exec();
  console.log(`\n─── connected accounts (${accounts.length}) ───`);
  for (const a of accounts) {
    let label = String(a.owner_id);
    if (a.owner_type === 'user') {
      const u = await UserModel.findById(a.owner_id).lean().exec();
      label = u?.display_name ?? u?.email ?? label;
    }
    console.log(
      `  ${a.owner_type.padEnd(8)} ${label.padEnd(24)} stripe=${a.stripe_account_id}  ` +
        `charges=${a.charges_enabled ?? false}  payouts=${a.payouts_enabled ?? false}`,
    );
  }
  if (accounts.length === 0) console.log('  (none — nobody has run Connect onboarding)');

  const settlements = await SettlementModel.find().sort({ settled_at: -1 }).lean().exec();
  console.log(`\n─── settlements (${settlements.length}) ───`);
  for (const s of settlements) {
    console.log(
      `  checkout=${s.checkout_id}  gross=${s.gross_sales_cents}  sellerNet=${s.seller_net_cents}` +
        `  hub=${s.hub_share_cents}\n      sellerTransfer=${s.seller_payout_ref ?? 'NONE (no payout-enabled account)'}` +
        `  hubTransfer=${s.hub_payout_ref ?? 'NONE'}`,
    );
  }
  if (settlements.length === 0) console.log('  (none)');
  console.log('');
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
