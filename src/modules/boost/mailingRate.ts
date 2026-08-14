import {
  BOOST_MAILING_RATE_TTL_SEC,
  BOOST_POSTCARD_MAIL_CLASS,
  BOOST_POSTCARD_SIZE_KEY,
  BOOST_POSTCARD_UNIT_COST_CENTS,
} from '../../config/constants';
import { logger } from '../../config/logger';
import { printVendor } from '../../integrations/print';
import { kv } from '../../shared/kv';

/**
 * What one mailed postcard actually costs — the number that made Boost inert.
 *
 * ## Why this is a lookup and not a constant
 *
 * `BOOST_POSTCARD_UNIT_COST_CENTS` was zero because no vendor was contracted, and the comment
 * there was explicit that inventing a figure would be read as a quote somebody had obtained. That
 * constraint is gone — a vendor is integrated and publishes live per-piece pricing — but pinning
 * their price into a constant would replace one problem with a slower one: a number that was true
 * on the day someone edited it, silently wrong after their next price change, on a page where
 * contributors are deciding how much money to give.
 *
 * So the rate is READ from the vendor and cached. The constant survives only as an override.
 *
 * ## The property worth preserving
 *
 * **A number is shown only when it is actually known.** Every failure path here returns `null`, and
 * the caller renders nothing rather than guessing — the same discipline the original code had, kept
 * intact through a change that made it much easier to lose.
 */

const log = logger.child({ module: 'boost.mailingRate' });

const CACHE_KEY = `boost:mailing-rate:${BOOST_POSTCARD_SIZE_KEY}:${BOOST_POSTCARD_MAIL_CLASS}`;
/** Negative caching, so a vendor outage is not amplified into a request-per-pageview. */
const MISS_TTL_SEC = 300;
const MISS_SENTINEL = 'none';

/** Process-local memo, so a burst of estimates in one request cycle hits neither KV nor vendor. */
let memo: { cents: number | null; expiresAt: number } | null = null;

export interface MailingRate {
  unitCostCents: number;
  /** Where the number came from — surfaced in logs and ops tooling, never to buyers. */
  source: 'vendor' | 'configured';
}

/** Clears both cache layers. For tests and for ops after a vendor price change. */
export async function invalidateMailingRate(): Promise<void> {
  memo = null;
  await kv().del(CACHE_KEY);
}

/**
 * Resolves the per-piece rate, or `null` when it genuinely cannot be known.
 *
 * Order: process memo → KV → vendor → configured override. Never throws: a campaign page must not
 * fail because a print vendor is slow, it must simply omit the estimate.
 */
export async function resolveMailingRate(): Promise<MailingRate | null> {
  const now = Date.now();
  if (memo && memo.expiresAt > now) {
    return memo.cents === null ? configuredFallback() : { unitCostCents: memo.cents, source: 'vendor' };
  }

  try {
    const cached = await kv().get(CACHE_KEY);
    if (cached === MISS_SENTINEL) {
      memo = { cents: null, expiresAt: now + MISS_TTL_SEC * 1000 };
      return configuredFallback();
    }
    if (cached) {
      const cents = Number(cached);
      if (Number.isInteger(cents) && cents > 0) {
        memo = { cents, expiresAt: now + BOOST_MAILING_RATE_TTL_SEC * 1000 };
        return { unitCostCents: cents, source: 'vendor' };
      }
    }
  } catch (err) {
    // KV is best-effort everywhere in this codebase; fall through to the vendor.
    log.warn({ err }, 'mailing rate cache read failed');
  }

  const fetched = await fetchFromVendor();
  if (fetched === null) {
    memo = { cents: null, expiresAt: now + MISS_TTL_SEC * 1000 };
    await kv()
      .set(CACHE_KEY, MISS_SENTINEL, MISS_TTL_SEC)
      .catch(() => undefined);
    return configuredFallback();
  }

  memo = { cents: fetched, expiresAt: now + BOOST_MAILING_RATE_TTL_SEC * 1000 };
  await kv()
    .set(CACHE_KEY, String(fetched), BOOST_MAILING_RATE_TTL_SEC)
    .catch(() => undefined);
  return { unitCostCents: fetched, source: 'vendor' };
}

async function fetchFromVendor(): Promise<number | null> {
  try {
    const price = await printVendor().priceRun({
      sizeKey: BOOST_POSTCARD_SIZE_KEY,
      mailClass: BOOST_POSTCARD_MAIL_CLASS,
      /**
       * Quantity 1 selects the vendor's entry-level break. Boost campaigns are small and their
       * final size is unknown while contributions are still coming in, so quoting a volume rate
       * the campaign may never reach would overstate what a contribution buys. Erring toward the
       * dearer rate means the count shown is a floor, not a hope.
       */
      quantity: 1,
    });
    return price.unitCostCents > 0 ? price.unitCostCents : null;
  } catch (err) {
    log.warn({ err }, 'could not read the mailing rate from the print vendor');
    return null;
  }
}

function configuredFallback(): MailingRate | null {
  return BOOST_POSTCARD_UNIT_COST_CENTS > 0
    ? { unitCostCents: BOOST_POSTCARD_UNIT_COST_CENTS, source: 'configured' }
    : null;
}
