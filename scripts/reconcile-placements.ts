/* eslint-disable no-console */
/**
 * Rescue placements that were paid for but never activated (missed webhook).
 *
 * Read-only against Stripe; only ever moves a placement FORWARD, and only when Stripe itself says
 * the money arrived. Safe to run repeatedly.
 *
 *   npm run reconcile:placements
 */
import { connectMongo, disconnectMongo } from '../src/config/db';
import { adsService } from '../src/modules/ads/ads.service';

async function main(): Promise<void> {
  await connectMongo();
  const res = await adsService.reconcilePendingPayments();
  console.log(`\nchecked ${res.checked} pending placement(s), activated ${res.activated}\n`);
  await disconnectMongo();
}

void main().catch(async (e: unknown) => {
  console.error(e);
  await disconnectMongo();
  process.exit(1);
});
