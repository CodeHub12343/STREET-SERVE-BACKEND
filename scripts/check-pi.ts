/** Read-only: what does Stripe actually say about the charge our ledger still calls `pending`? */
import { stripe } from '../src/integrations/stripe';

const refs = ['pi_3TuS8IDQLfeG3uzw2L2ltp5W'];

async function main() {
  for (const ref of refs) {
    try {
      const intent = await stripe().retrievePaymentIntent(ref);
      console.log(`${ref} -> status=${intent.status} amount=${(intent.amountCents / 100).toFixed(2)}`);
    } catch (err) {
      console.log(`${ref} -> ERROR ${(err as Error).message}`);
    }
  }
}

void main();
