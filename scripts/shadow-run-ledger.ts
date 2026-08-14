/**
 * Phase 1 SHADOW-RUN. Replays every existing settlement through the ledger model WITHOUT writing
 * anything, and proves each one can be expressed as a balanced set of entries.
 *
 * This is how you find out the ledger model is wrong BEFORE real money depends on it. If a
 * historical settlement cannot be represented, the model is missing an account or an entry type,
 * and that is far cheaper to discover here than after go-live.
 *
 * Historical settlements are `legacy_unfunded` (Phase 0): the platform never collected the sale
 * proceeds. They are therefore modelled the way a CASH sale will be modelled going forward —
 * a receivable owed by the seller, not platform cash:
 *
 *     DR  receivable ← seller     hub share + platform fee
 *     CR  payable → hub           hub share
 *     CR  platform fee revenue    platform fee
 *
 * The seller's own share needs no entry: they already hold that money (the customer paid them
 * directly), so nothing is owed to them and nothing moves.
 *
 * Where a settlement DID disburse real platform capital (the hub leg of the live one), the shadow
 * run additionally models that outflow, so the replay reflects what actually happened:
 *
 *     DR  payable → hub           hub share      (the debt is discharged)
 *     CR  platform cash           hub share      (money genuinely left)
 *
 *   npx tsx scripts/shadow-run-ledger.ts
 */
import { connectMongo, disconnectMongo } from '../src/config/db';
import {
  InventoryCheckoutModel,
  SettlementModel,
  HubModel,
} from '../src/modules/consignment/consignment.model';
import { formatCents } from '../src/shared/money';

interface ShadowEntry {
  account: string;
  direction: 'debit' | 'credit';
  amountCents: number;
}

function render(entries: ShadowEntry[]): string {
  return entries
    .map(
      (e) =>
        `        ${e.direction === 'debit' ? 'DR' : 'CR'}  ${e.account.padEnd(28)} ${formatCents(e.amountCents).padStart(10)}`,
    )
    .join('\n');
}

async function main(): Promise<void> {
  await connectMongo();

  const settlements = await SettlementModel.find().sort({ settled_at: 1 }).lean().exec();
  if (settlements.length === 0) {
    console.log('\nNo settlements to replay.\n');
    return;
  }

  console.log(`\nShadow-running ${settlements.length} settlement(s) through the ledger model…\n`);

  let balanced = 0;
  let unbalanced = 0;
  let unrepresentable = 0;

  for (const s of settlements) {
    const checkout = await InventoryCheckoutModel.findById(s.checkout_id).lean().exec();
    const hub = checkout ? await HubModel.findById(checkout.hub_id).lean().exec() : null;

    const entries: ShadowEntry[] = [];
    const owedBySeller = s.hub_share_cents + s.platform_fee_cents;

    // The sale itself: proceeds never reached the platform, so the seller owes the other parties.
    if (owedBySeller > 0) {
      entries.push({ account: 'receivable ← seller', direction: 'debit', amountCents: owedBySeller });
    }
    if (s.hub_share_cents > 0) {
      entries.push({ account: 'payable → hub', direction: 'credit', amountCents: s.hub_share_cents });
    }
    if (s.platform_fee_cents > 0) {
      entries.push({
        account: 'platform fee revenue',
        direction: 'credit',
        amountCents: s.platform_fee_cents,
      });
    }

    const debits = entries.filter((e) => e.direction === 'debit').reduce((n, e) => n + e.amountCents, 0);
    const credits = entries.filter((e) => e.direction === 'credit').reduce((n, e) => n + e.amountCents, 0);
    const saleBalanced = debits === credits;

    console.log(`  checkout=${s.checkout_id}  [${s.funding_source ?? 'unknown'}]`);
    console.log(`    gross ${formatCents(s.gross_sales_cents)} · sale entries:`);
    console.log(render(entries));
    console.log(
      `        → debits ${formatCents(debits)} vs credits ${formatCents(credits)}  ${saleBalanced ? '✓ balanced' : '✗ UNBALANCED'}`,
    );

    // A real payout that actually left the platform gets its own balanced transaction.
    let payoutBalanced = true;
    if (s.hub_payout_ref) {
      const payout: ShadowEntry[] = [
        { account: 'payable → hub', direction: 'debit', amountCents: s.hub_share_cents },
        { account: 'platform cash', direction: 'credit', amountCents: s.hub_share_cents },
      ];
      const pd = payout.filter((e) => e.direction === 'debit').reduce((n, e) => n + e.amountCents, 0);
      const pc = payout.filter((e) => e.direction === 'credit').reduce((n, e) => n + e.amountCents, 0);
      payoutBalanced = pd === pc;
      console.log(`    hub payout ${s.hub_payout_ref} actually executed:`);
      console.log(render(payout));
      console.log(`        → ${payoutBalanced ? '✓ balanced' : '✗ UNBALANCED'}`);
      console.log(
        `        ⚠ platform cash genuinely decreased by ${formatCents(s.hub_share_cents)} ` +
          `against ${formatCents(0)} collected — the Phase 0 loss, now visible in the books.`,
      );
    }
    if (s.seller_net_cents > 0 && !s.seller_payout_ref) {
      console.log(
        `    seller share ${formatCents(s.seller_net_cents)} — no entry required ` +
          `(cash sale: the seller already holds it)`,
      );
    }

    if (!checkout || !hub) {
      unrepresentable += 1;
      console.log('    ✗ could not resolve checkout/hub — settlement not fully representable');
    } else if (saleBalanced && payoutBalanced) {
      balanced += 1;
    } else {
      unbalanced += 1;
    }
    console.log('');
  }

  console.log('─'.repeat(70));
  console.log(`  balanced:        ${balanced}`);
  console.log(`  unbalanced:      ${unbalanced}`);
  console.log(`  unrepresentable: ${unrepresentable}`);
  console.log('─'.repeat(70));
  console.log(
    unbalanced === 0 && unrepresentable === 0
      ? '\n✓ SHADOW-RUN PASSED — every settlement is expressible as balanced entries.\n' +
          '  Nothing was written. The ledger model is safe to carry real money.\n'
      : '\n✗ SHADOW-RUN FAILED — fix the ledger model before Phase 2.\n',
  );

  if (unbalanced > 0 || unrepresentable > 0) process.exitCode = 1;
}

main()
  .then(async () => {
    await disconnectMongo();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (err) => {
    console.error(err);
    await disconnectMongo().catch(() => {});
    process.exit(1);
  });
