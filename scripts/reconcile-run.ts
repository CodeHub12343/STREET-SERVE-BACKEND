/**
 * Run the payouts reconciliation against the real ledger + Stripe for one business, printing the
 * before/after. This corrects charges that genuinely succeeded at Stripe but that our ledger still
 * records as `pending` — the same thing that happens automatically when the owner opens /vendor/payouts.
 */
import mongoose from 'mongoose';
import { connectMongo } from '../src/config/db';
import { TransactionModel } from '../src/modules/payments/payments.model';
import { paymentsService } from '../src/modules/payments/payments.service';

const BUSINESS_ID = '6a5a21088d8a5c825f3ab952'; // Santiago Funiture Hub

const money = (c: number) => '$' + (c / 100).toFixed(2);

async function summarise(label: string) {
  const txns = await TransactionModel.find({ counterparty_id: BUSINESS_ID }).lean().exec();
  const net = (t: (typeof txns)[number]) =>
    (t.fee_breakdown as { counterparty_net_cents?: number } | undefined)?.counterparty_net_cents ??
    t.amount_cents - t.platform_fee_cents;
  const completed = txns.filter((t) => t.status === 'completed');
  const pending = txns.filter((t) => t.status === 'pending');
  console.log(`\n${label}`);
  console.log(`  completed: ${completed.length}  earned=${money(completed.reduce((s, t) => s + net(t), 0))}`);
  console.log(`  pending  : ${pending.length}  (${pending.map((t) => money(net(t))).join(', ') || 'none'})`);
}

async function main() {
  await connectMongo();
  await summarise('BEFORE reconciliation');
  const settled = await paymentsService.reconcilePendingCharges(BUSINESS_ID);
  console.log(`\n  -> settled ${settled} charge(s) that Stripe reports as succeeded`);
  await summarise('AFTER reconciliation');
  await mongoose.disconnect();
}

void main();
