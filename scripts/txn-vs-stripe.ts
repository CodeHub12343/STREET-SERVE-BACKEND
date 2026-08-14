/** Read-only: for each transaction, does our ledger status agree with Stripe's PaymentIntent? */
import mongoose from 'mongoose';
import { connectMongo } from '../src/config/db';
import { TransactionModel } from '../src/modules/payments/payments.model';
import { stripe } from '../src/integrations/stripe';

const BUSINESS_ID = '6a5a21088d8a5c825f3ab952';
const money = (c: number) => '$' + (c / 100).toFixed(2);

async function main() {
  await connectMongo();
  const txns = await TransactionModel.find({ counterparty_id: BUSINESS_ID }).sort({ created_at: 1 }).lean().exec();
  for (const t of txns) {
    const net =
      (t.fee_breakdown as { counterparty_net_cents?: number } | undefined)?.counterparty_net_cents ??
      t.amount_cents - t.platform_fee_cents;
    let stripeStatus = 'no payment_intent_ref';
    if (t.payment_intent_ref) {
      try {
        stripeStatus = (await stripe().retrievePaymentIntent(t.payment_intent_ref)).status;
      } catch (e) {
        stripeStatus = 'ERROR ' + (e as Error).message.slice(0, 40);
      }
    }
    const agree = t.status === 'completed' && stripeStatus === 'succeeded';
    console.log(
      `ours=${String(t.status).padEnd(10)} stripe=${stripeStatus.padEnd(24)} net=${money(net).padStart(8)} ${agree ? 'ok' : '  <-- MISMATCH'}`,
    );
  }
  await mongoose.disconnect();
}

void main();
