/* eslint-disable no-console */
/**
 * Print-vendor harness — the Phase 1 exit criterion.
 *
 * Walks the real PostcardMania DirectMail v3 flow end to end against whichever gateway is
 * configured: the fake by default, the live sandbox with `--real`. The same script proves the same
 * domain contract either way, so a difference between them is a genuine integration finding.
 *
 * ## Safety
 *
 * `submitOrder` is the only call that spends money, so it is OFF unless `--submit` is passed, and
 * refused outright against production. Read-only probing is the default.
 *
 *   npm run probe:print                        # fake, read-only — always safe
 *   npm run probe:print -- --real              # live sandbox, read-only
 *   npm run probe:print -- --real --submit     # live sandbox, WILL place an order
 */

import { env } from '../src/config/env';
import { createFakePrintVendor } from '../src/integrations/print/fake';
import { buildRealGateway } from '../src/integrations/print/gateway';
import type { MailClass, PrintVendorGateway } from '../src/integrations/print/types';

const args = new Set(process.argv.slice(2));
const useReal = args.has('--real');
const allowSubmit = args.has('--submit');

/**
 * 6" × 8.5". Matches the product registry's default, and unlike `69` it actually exists on the
 * account — `46S`, `58` and `69` return no designs at all, so pricing them fails with a message
 * about there being no published price rather than about the size being unavailable.
 */
const SIZE_KEY = '68';
const MAIL_CLASS: MailClass = 'standard';
const ZIP = '95350'; // Modesto — the platform's DEFAULT_CITY

const pass = (m: string): void => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m: string, e: unknown): void =>
  console.log(`  \x1b[31m✗\x1b[0m ${m}\n      ${e instanceof Error ? e.message : String(e)}`);
const skip = (m: string): void => console.log(`  \x1b[90m–\x1b[0m ${m}`);
const info = (m: string): void => console.log(`      → ${m}`);

async function main(): Promise<void> {
  console.log('\n═══ Print vendor probe (PostcardMania DirectMail v3) ═══\n');

  if (useReal && env.PCM_ENVIRONMENT === 'production') {
    console.error('Refusing to probe the PRODUCTION print queue. Use the sandbox credentials.\n');
    process.exit(1);
  }
  if (useReal && !(env.PCM_API_KEY && env.PCM_API_SECRET)) {
    console.error(
      '--real needs BOTH PCM_API_KEY and PCM_API_SECRET.\n' +
        'The vendor logs in with a key + secret pair; a key alone cannot authenticate.\n' +
        'Both are generated together in the portal: My Account → API Keys.\n',
    );
    process.exit(1);
  }

  const vendor: PrintVendorGateway = useReal ? buildRealGateway() : createFakePrintVendor();

  console.log(`  gateway     : ${useReal ? 'REAL' : 'fake'}`);
  console.log(`  environment : ${env.PCM_ENVIRONMENT}`);
  console.log(`  base url    : ${env.PCM_API_BASE_URL}`);
  console.log(`  submit      : ${allowSubmit ? 'ENABLED (will place an order)' : 'disabled'}\n`);

  let failures = 0;
  const step = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      const out = await fn();
      pass(label);
      return out;
    } catch (e) {
      fail(label, e);
      failures++;
      return null;
    }
  };

  // 1. Auth is exercised implicitly by the first authenticated call.
  const types = await step('listTypes (also proves /auth/login)', () => vendor.listTypes());
  if (types?.length) info(`${types.length} list type(s): ${types.map((t) => t.key).join(', ')}`);

  const balance = await step('getBalance', () => vendor.getBalance());
  if (balance) info(`retainer $${(balance.moneyOnAccountCents / 100).toFixed(2)}`);

  /**
   * Prefer the general resident/occupant list. Taking `types[0]` blindly picked a niche list on the
   * live account and reported 349 deliverable addresses for a whole Modesto ZIP — the same ZIP
   * returns ~21,000 on `IRL`. A probe that under-reports by 60x is worse than no probe.
   */
  const listType = types?.find((t) => t.key === 'IRL')?.key ?? types?.[0]?.key ?? 'IRL';
  const count = await step(`createAudienceCount (zip ${ZIP})`, () =>
    vendor.createAudienceCount({ type: 'zip', keys: [ZIP], listType }),
  );
  if (count) {
    info(`listCountID ${count.listCountId}, ${count.recordCount} deliverable`);
    // The privacy property worth checking on the live API, not just the fake.
    const leaks = /"(address|firstName|lastName)"/i.test(JSON.stringify(count));
    console.log(
      leaks
        ? '      \x1b[31m! response contained recipient fields — consumer PII may be entering our systems\x1b[0m'
        : '      → no recipient PII in the response (vendor holds the list)',
    );
    if (leaks) failures++;
  }

  const price = count
    ? await step('priceRun', () =>
        vendor.priceRun({ sizeKey: SIZE_KEY, mailClass: MAIL_CLASS, quantity: count.recordCount }),
      )
    : null;
  if (price) {
    info(
      `wholesale $${(price.vendorCostCents / 100).toFixed(2)} ` +
        `(${price.unitCostCents}c/piece at break ≥${price.appliedBreak.minQuantity}, ` +
        `binding: ${String(price.isBinding)})`,
    );
  }

  if (!count) {
    skip('submitOrder — no list count');
  } else if (!allowSubmit) {
    skip('submitOrder — pass --submit to enable (places a real order)');
  } else {
    const orderRef = `probe_${Date.now()}`;
    const req = {
      sizeKey: SIZE_KEY,
      mailClass: MAIL_CLASS,
      listCountId: count.listCountId,
      recordCount: count.recordCount,
      artwork: {
        frontUrl: 'https://example.com/probe-front.pdf',
        backUrl: 'https://example.com/probe-back.pdf',
      },
      orderRef,
      mailDate: new Date(Date.now() + 7 * 864e5),
      returnAddress: {
        company: 'StreetServe',
        address: '1 Main St',
        city: 'Modesto',
        state: 'CA',
        zipCode: ZIP,
      },
    };

    const ref = await step('submitOrder', () => vendor.submitOrder(req));
    if (ref) {
      info(`vendor order ${ref.vendorOrderId} (batch ${ref.vendorBatchId})`);
      const status = await step('getStatus', () => vendor.getStatus(ref.vendorOrderId));
      if (status) info(`status ${status}`);

      // The invariant that makes retry safe: a repeat reference must be refused, not reprinted.
      try {
        await vendor.submitOrder(req);
        console.log(
          '  \x1b[31m✗\x1b[0m duplicate order reference was ACCEPTED — ' +
            'that is a second print run. DO NOT enable submission retries.',
        );
        failures++;
      } catch {
        pass('duplicate order reference rejected (retry is safe)');
      }

      await step('cancelOrder (before batch cutoff)', () => vendor.cancelOrder(ref.vendorOrderId));
    }
  }

  console.log(
    failures === 0
      ? '\n\x1b[32mAll probed steps passed.\x1b[0m\n'
      : `\n\x1b[31m${failures} step(s) failed.\x1b[0m\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
