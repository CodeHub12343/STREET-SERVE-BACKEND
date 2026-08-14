/* eslint-disable no-console */
/**
 * Postcard pilot review (Phase 8.2) — read-only.
 *
 * Prints the four things the roadmap asks before general availability: actual versus quoted cost,
 * margin realised, how long artwork sat waiting for a human, and which failure modes actually
 * happened rather than which ones were predicted.
 *
 *   npm run pilot:review
 *
 * Everything is measured or reported as unknown. Nothing is estimated — the whole point of the
 * exercise is to replace the audit's assumed unit economics with real ones, and a report that
 * quietly fills a gap with a default would leave that assumption in place while looking like
 * evidence.
 */

import { connectMongo, disconnectMongo } from '../src/config/db';
import { pilotReviewService } from '../src/modules/postcards/pilotReview.service';
import { pilotService } from '../src/modules/postcards/pilot.service';
import { formatCents } from '../src/shared/money';

const dim = (s: string): string => `\x1b[90m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;

/** `null` means not measurable yet — say so rather than printing a zero that reads as a finding. */
const money = (c: number | null): string => (c === null ? dim('not yet measurable') : formatCents(c));
const mins = (m: number | null): string => (m === null ? dim('—') : m < 60 ? `${m} min` : `${(m / 60).toFixed(1)}h`);

async function main(): Promise<void> {
  await connectMongo();

  const [review, roster] = await Promise.all([pilotReviewService.build(), pilotService.list()]);

  console.log(`\n${bold('═══ Postcard pilot review ═══')}\n`);
  console.log(`  mode          : ${review.mode}`);
  console.log(`  margin basis  : ${review.marginBasis}`);
  console.log(`  participants  : ${roster.activeCount} active of ${roster.participants.length}`);
  console.log(`  per-order cap : ${formatCents(roster.maxOrderCents)}`);

  console.log(`\n${bold('Orders')}`);
  console.log(`  total ${review.orders.total} · submitted ${review.orders.submitted} · mailed ${review.orders.mailed}`);
  for (const [status, n] of Object.entries(review.orders.byStatus).sort()) {
    console.log(`    ${status.padEnd(20)} ${n}`);
  }

  console.log(`\n${bold('Economics')} ${dim('(the question the pilot exists to answer)')}`);
  const e = review.economics;
  console.log(`  charged to buyers      ${formatCents(e.grossChargedCents)}`);
  console.log(`  vendor cost, quoted    ${formatCents(e.quotedVendorCostCents)}`);
  console.log(`  vendor cost, settled   ${formatCents(e.settledVendorCostCents)} ${dim(`(${e.settledOrderCount} order(s))`)}`);
  console.log(`  margin, quoted         ${formatCents(e.marginQuotedCents)}`);
  console.log(`  ${bold('margin, realised')}       ${money(e.marginRealisedCents)}`);

  if (e.costVariancePercent === null) {
    console.log(
      `  ${yellow('variance')}               ${dim('unverified — no vendor payable has settled yet')}`,
    );
  } else {
    const over = e.costVariancePercent > 0;
    const tone = Math.abs(e.costVariancePercent) > 5 ? red : green;
    console.log(
      `  variance               ${tone(`${over ? '+' : ''}${e.costVariancePercent}%`)} ` +
        `(${money(e.costVarianceCents)} ${over ? 'MORE than quoted' : 'less than quoted'})`,
    );
  }

  console.log(`\n${bold('Moderation')} ${dim('(TD-8 — the scaling bottleneck)')}`);
  const m = review.moderation;
  console.log(`  reviewed ${m.reviewed} · approved ${m.approved} · rejected ${m.rejected} · waiting ${m.stillWaiting}`);
  console.log(`  wait: median ${mins(m.medianMinutes)} · p90 ${mins(m.p90Minutes)}`);

  console.log(`\n${bold('Failure modes')} ${dim('(what actually happened)')}`);
  for (const [k, v] of Object.entries(review.failures)) {
    const label = k.replace(/([A-Z])/g, ' $1').toLowerCase();
    console.log(`  ${label.padEnd(26)} ${v === 0 ? dim('0') : v > 0 && k !== 'submissionRetriesUsed' ? red(String(v)) : String(v)}`);
  }

  console.log(`\n${bold('Before going general')}`);
  for (const line of review.readiness) console.log(`  ${yellow('•')} ${line}`);

  console.log(
    `\n${dim('This is evidence, not a decision. A person reads it and decides.')}\n`,
  );

  await disconnectMongo();
}

void main().catch(async (err: unknown) => {
  console.error(err);
  await disconnectMongo();
  process.exit(1);
});
