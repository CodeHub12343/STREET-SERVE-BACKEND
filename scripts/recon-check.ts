/** Read-only: does lifetime earned now line up with what's actually sitting at Stripe? */
import mongoose from 'mongoose';
import { connectMongo } from '../src/config/db';
import { ConnectedAccountModel, TransactionModel } from '../src/modules/payments/payments.model';
import { stripe } from '../src/integrations/stripe';

const BUSINESS_ID = '6a5a21088d8a5c825f3ab952';
const money = (c: number) => '$' + (c / 100).toFixed(2);

async function main() {
  await connectMongo();
  const acct = await ConnectedAccountModel.findOne({ owner_id: BUSINESS_ID }).lean().exec();
  const txns = await TransactionModel.find({ counterparty_id: BUSINESS_ID }).lean().exec();
  const net = (t: (typeof txns)[number]) =>
    (t.fee_breakdown as { counterparty_net_cents?: number } | undefined)?.counterparty_net_cents ??
    t.amount_cents - t.platform_fee_cents;
  const earned = txns.filter((t) => t.status === 'completed').reduce((s, t) => s + net(t), 0);

  const bal = await stripe().getBalance(acct!.stripe_account_id);
  const atStripe = bal.availableCents + bal.pendingCents;

  console.log('lifetime earned (our ledger, completed) : ' + money(earned));
  console.log('available at Stripe                     : ' + money(bal.availableCents));
  console.log('clearing at Stripe                      : ' + money(bal.pendingCents));
  console.log('total at Stripe                         : ' + money(atStripe));
  console.log('difference (earned - atStripe)          : ' + money(earned - atStripe));
  console.log(earned === atStripe ? '=> RECONCILED exactly' : '=> difference = already paid out to bank (or fees/refunds)');
  await mongoose.disconnect();
}

void main();
