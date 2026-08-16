/**
 * Enums and business defaults sourced from the PRD (docs/05) and blueprint. Anything a
 * product decision could change lives here (or in DB config), never scattered as magic numbers.
 */

// ─── Roles (additive, one identity — AUTHENTICATION_AND_AUTHORIZATION.md §2) ────────────────
export const ROLES = [
  'customer',
  'seller',
  'vendor',
  'hub',
  'shelter_admin',
  'sponsor',
  /**
   * Delivery Assist Network (ADR-004). A driver is an ENGAGEMENT, not an employee: they accept
   * discrete offers at a disclosed price and may decline any of them without consequence.
   *
   * Deliberately absent from `SELF_GRANTABLE_ROLES` — the role carries a licence, an insurance
   * attestation, and a background check, so it is granted only after vetting. See DRIVER_MIN_TIER.
   */
  'driver',
  'admin',
  'ops_finance',
] as const;
export type Role = (typeof ROLES)[number];

export const DEFAULT_ROLE: Role = 'customer';
/**
 * Roles a user MAY self-grant via /auth/roles — an allowlist. Anything absent here is refused with
 * CANNOT_SELF_GRANT_ROLE (identity.service.ts `addRoleSelf`).
 *
 * The comment here used to say the opposite ("roles a user may never self-grant"), which is a
 * dangerous thing for it to say about an allowlist: anyone adding a role while trusting it would
 * have been granting free self-service to precisely the role they meant to restrict. Any role
 * carrying vetting — a background check, a licence, an insurance attestation — must NOT be added.
 */
export const SELF_GRANTABLE_ROLES: Role[] = ['seller', 'vendor', 'hub'];
export const ADMIN_ROLES: Role[] = ['admin', 'ops_finance'];

/**
 * ADR-004 §4 — the verification floor for taking delivery offers. Vetting is the one place the
 * platform SHOULD exercise control: a background check is about third-party safety, and unlike
 * directing how the work is performed it does not bear on the engagement classification.
 *
 * `silver` requires a bank account on top of ID, which is also the payout rail a driver needs.
 */
export const DRIVER_MIN_TIER: Tier = 'silver';

// ─── Verification tiers (capability gate) ──────────────────────────────────────────────────
export const TIERS = ['tier0', 'bronze', 'silver', 'gold'] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_RANK: Record<Tier, number> = { tier0: 0, bronze: 1, silver: 2, gold: 3 };

// ─── Account status ────────────────────────────────────────────────────────────────────────
export const USER_STATUSES = ['active', 'suspended', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

// ─── Business status model (three-state — docs/03 §2a) ─────────────────────────────────────
export const LIVE_STATUSES = ['driving', 'parked', 'away_closed'] as const;

// ─── Category top-level tabs (client map filter) ───────────────────────────────────────────
export const CATEGORY_TABS = ['food', 'coffee', 'services', 'shopping', 'more'] as const;
export type CategoryTab = (typeof CATEGORY_TABS)[number];

// ─── Business archetypes + modules (BUSINESS_MODULE_SYSTEM.md) ──────────────────────────────
/**
 * A category declares one archetype; the archetype supplies the business's default modules.
 * This is what keeps "support every business type" a 4-problem instead of an N-problem — a new
 * category inherits a complete, sensible product with no code change.
 */
export const ARCHETYPES = [
  'counter_serve', // product, on the spot: food truck, coffee cart
  'appointment_service', // time, booked ahead: barber, nails, notary
  'on_demand_service', // time, dispatched now: mechanic, locksmith
  'goods_seller', // physical goods: handmade, apparel, plants
] as const;
export type Archetype = (typeof ARCHETYPES)[number];

/**
 * Fallback for categories created before archetypes existed, or by a path that doesn't set one
 * yet (admin category-suggestion approval — BP-5 adds an explicit selector). Deriving from the
 * tab keeps a legacy row resolvable instead of crashing the resolver.
 */
export const DEFAULT_ARCHETYPE_BY_TAB: Record<CategoryTab, Archetype> = {
  food: 'counter_serve',
  coffee: 'counter_serve',
  services: 'on_demand_service',
  shopping: 'goods_seller',
  more: 'goods_seller',
};

/** Every capability a business can run. Each maps to an API surface that already exists. */
export const MODULES = [
  // Core — always on, never disable-able.
  'live_presence',
  'profile',
  'reviews',
  'messaging',
  'payouts',
  'analytics',
  // Auto — derived from data, not owner choice.
  'licensing',
  'hub_operations',
  // Optional.
  'menu',
  'ordering',
  'queue',
  'wave_down',
  'services',
  'booking',
  'catalog',
  'consignment',
  'gifting',
  'giveaways',
  'pay_it_forward',
  'ping_sharing',
  'ai_assistant',
] as const;
export type Module = (typeof MODULES)[number];

// ─── Pay It Forward (ADR-005) ──────────────────────────────────────────────────────────────
/**
 * How long a contribution stays redeemable. **"Never" is deliberately not offered.** An unbounded
 * liability is one the platform can never close its books against, and several US states treat
 * long-dormant prepaid balances as unclaimed property with escheatment obligations.
 */
export const PAY_FORWARD_EXPIRY_DAY_OPTIONS = [30, 60, 365] as const;
export const PAY_FORWARD_DEFAULT_EXPIRY_DAYS = 365;
/** Notice to the vendor this many days before money in their pool goes stale, so it can be used. */
export const PAY_FORWARD_EXPIRY_NOTICE_DAYS = 30;
/**
 * How long a contribution may sit `pending` before the reconcile sweep asks Stripe what actually
 * happened to it. A grace period rather than zero, so the sweep never races the webhook it exists
 * to back up: an intent opened seconds ago is in flight, not late. Fifteen minutes is far inside
 * Stripe's retry window, so a genuinely-delivered webhook always wins.
 */
export const PAY_FORWARD_RECONCILE_AFTER_MS = 15 * 60_000;
/**
 * ADR-005 §7 — how long a giver has to take a gift back.
 *
 * Only the UNSPENT remainder is ever returned. Money that has already covered someone's order is
 * gone in the only sense that matters: a person ate. Clawing that back would mean either asking
 * them to give a meal back or making the platform absorb a loss anyone could trigger deliberately.
 */
export const PAY_FORWARD_REFUND_WINDOW_MS = 24 * 60 * 60_000;
/**
 * How long a covered order may hold community money before an unpaid checkout releases it.
 *
 * The fund is committed when the order is PLACED, but `release` only fires when the charge throws —
 * a customer who simply closes the payment sheet consumed the money permanently. Long enough for a
 * slow payment or a dropped connection; short enough that a small pool is not held hostage through
 * a lunch service by people who wandered off.
 */
export const PAY_FORWARD_ABANDON_AFTER_MS = 30 * 60_000;

/**
 * How long a Rent-to-Own agreement may sit on an unsettled intent before the reconcile sweep asks
 * Stripe directly. A grace period rather than zero, so the sweep never races the webhook it exists
 * to back up — and comfortably inside Stripe's own retry window, so a delivered event always wins.
 */
export const RTO_RECONCILE_AFTER_MS = 15 * 60_000;
/** Floor on a contribution. Below this the processing fee is most of the gift. */
export const PAY_FORWARD_MIN_CONTRIBUTION_CENTS = 100;
/**
 * Ceiling on a single contribution. Not a fraud control — it is a **mistake** control: the gap
 * between $50 and $5,000 is one stray keystroke, and a custodial balance is the worst place to
 * discover a typo.
 */
export const PAY_FORWARD_MAX_CONTRIBUTION_CENTS = 50_000;
/**
 * The verification floor for RECEIVING from a pool (PIF-10a). Deliberately low: this is help, and a
 * gate that keeps out the people the feature exists for would defeat it. `bronze` means a verified
 * identity — enough to make one-account-per-person meaningful — and nothing more.
 */
export const PAY_FORWARD_REDEEM_MIN_TIER: Tier = 'bronze';

// ─── Boost My Marketing (ADR-006) ──────────────────────────────────────────────────────────
/**
 * The hard ceiling on a campaign window. **No open-ended campaigns** — an indefinite hold on other
 * people's money is the escrow shape ADR-006 exists to avoid, and a campaign that can never fail can
 * never resolve either.
 */
export const BOOST_MAX_DEADLINE_DAYS = 60;
export const BOOST_DEFAULT_DEADLINE_DAYS = 30;
/**
 * $100. Chosen as "below this a mailing is not worth printing" — **and that calibration is now
 * known to be optimistic.** It assumed roughly 20¢ a piece; the vendor's actual entry-level rate
 * for a 6×8.5 Standard postcard is ~$1.03, so a minimum-goal campaign nets ~87 postcards after the
 * service fee, not the ~500 the figure implied.
 *
 * Deliberately NOT changed here: whether 87 postcards is a worthwhile drop is a product judgement
 * about which campaigns should be allowed to run, not an arithmetic fix. Raising it excludes the
 * smallest vendors, which cuts against the point of the feature.
 *
 * Two things would move it: a negotiated volume rate (the current price is un-negotiated rack rate
 * on an account with no contract), or a decision that a floor of ~87 pieces is too thin to sell.
 */
export const BOOST_MIN_GOAL_CENTS = 10_000;
export const BOOST_MAX_GOAL_CENTS = 1_000_000; // $10,000
export const BOOST_MIN_CONTRIBUTION_CENTS = 500;
export const BOOST_MAX_CONTRIBUTION_CENTS = 100_000;
/**
 * How long money that a contributor asked to ROLL FORWARD may wait for the business's next campaign
 * before it is refunded anyway (ADR-006 §5).
 *
 * Without this, "roll it into the next one" becomes exactly the indefinite hold the deadline was
 * introduced to prevent — the money would sit until a campaign that might never be created.
 */
export const BOOST_ROLLOVER_GRACE_DAYS = 60;
/**
 * FALLBACK cost of one mailed postcard, all-in, in cents. **Zero means "no fallback configured".**
 *
 * MB-8 is resolved — a vendor is integrated — but this constant deliberately stays at zero, because
 * the rate is no longer something to pin here. The vendor publishes live per-piece pricing, so
 * `boost/mailingRate.ts` reads the real number and this is only consulted if that read fails.
 *
 * Leaving it zero preserves the original property that made this code trustworthy: **a number is
 * shown only when it is actually known.** If the vendor is unreachable the estimate returns null and
 * the UI renders nothing, exactly as before — which is better than quoting a figure that was true
 * whenever someone last edited this line.
 *
 * Set it only to pin a contracted rate that the API does not yet reflect, and treat that as
 * temporary.
 */
export const BOOST_POSTCARD_UNIT_COST_CENTS = 0;
/**
 * The product a Boost campaign buys. Configuration, not a literal, because it is a product
 * decision (`constants.ts` §1) and because the vendor's catalogue varies by account: at the time
 * of integration only `46`, `68`, and `611` had designs and pricing on our account — `46S`, `58`,
 * and `69` returned nothing at all.
 *
 * `68` (6" × 8.5") on Standard mail is the default: the largest format that still prices close to
 * the cheapest, and Standard is the right class for marketing mail.
 */
export const BOOST_POSTCARD_SIZE_KEY = '68';
export const BOOST_POSTCARD_MAIL_CLASS = 'standard';
/**
 * How long a fetched per-piece rate is trusted. Short enough that a vendor price change reaches
 * campaign pages the same day; long enough that the estimate endpoint is not a proxy for their API.
 */
export const BOOST_MAILING_RATE_TTL_SEC = 6 * 60 * 60;

// ─── Print / direct-mail vendor (ADR-007, Topology B) ──────────────────────────────────────
/**
 * Whether the vendor is CONFIRMED to deduplicate repeat order submissions.
 *
 * **Now true, on documented evidence rather than assumption.** PostcardMania's DirectMail v3 spec
 * defines `extRefNbr` as an external reference and returns **409 on a duplicate** for every order
 * route. A retried submission therefore cannot produce a second print run — it either lands once
 * or is refused. That closes audit F-6, which was open only because this was unknown.
 *
 * If a future vendor lacks this, set it false: `submitOrder` stops auto-retrying and a timed-out
 * submission becomes a human's problem, which is slower and correct.
 */
export const PRINT_VENDOR_IDEMPOTENCY_CONFIRMED = true;
/** Per-call budget. Print APIs are slower than payment APIs; list counts hit their data engine. */
export const PRINT_VENDOR_TIMEOUT_MS = 15_000;
/**
 * Safety margin on the vendor's bearer-token expiry.
 *
 * Their auth is a login exchange returning a short-lived JWT. Using a token right up to its stated
 * expiry races the clock and fails intermittently — the worst failure mode on a money path — so
 * the cache renews this far ahead of it.
 */
export const PRINT_VENDOR_TOKEN_SKEW_MS = 60_000;
/** Retries for READ calls only (see above). Total attempts = 1 + this. */
export const PRINT_VENDOR_MAX_RETRIES = 2;
export const PRINT_VENDOR_RETRY_BASE_MS = 400;
/**
 * Sanity bounds on a per-piece wholesale cost, in cents. A quote outside this band is REJECTED
 * rather than charged: a vendor-side pricing bug that returns $500/piece must fail loudly, not
 * quietly bill a customer $250,000 for a 500-piece run (ARCHITECTURAL_IMPROVEMENTS.md §5).
 *
 * The band is deliberately wide — it is a guard against absurdity, not a pricing opinion. Narrow
 * it once real contracted rates are known (Phase 0.4).
 */
export const PRINT_QUOTE_MIN_UNIT_COST_CENTS = 5; // $0.05
export const PRINT_QUOTE_MAX_UNIT_COST_CENTS = 2_000; // $20.00

// ─── Postcard Marketing — product registry (PC-3, ADR-007 §1) ──────────────────────────────
/**
 * The postcard products a business may order.
 *
 * **Configuration, not a collection.** The audit planned a `postcard_products` table; the vendor's
 * catalogue turned out to be the real source of truth (sizes, availability and pricing all come
 * from their API and vary by account), so a table would be a second copy of someone else's data,
 * free to drift and needing a migration and admin CRUD to maintain three rows. A registry here
 * honours the same rule — "anything a product decision could change lives here (or in DB config)" —
 * without the duplication. `postcards.test.ts` asserts every SKU is one the vendor actually offers.
 *
 * Only `46`, `68` and `611` are listed because only those returned designs and pricing on our
 * account; `46S`, `58` and `69` returned nothing at all.
 *
 * `designedSides: 1` is the MVP decision, and it is not the same as printed sides. A mailed
 * postcard must carry an address side, and the vendor requires BOTH `front` and `back` on every
 * order — so the buyer designs one side and the platform supplies the other.
 */
export interface PostcardProduct {
  /** Vendor size key. Passed through verbatim. */
  sku: string;
  label: string;
  /** Sides the BUYER designs. Printed sides are always two. */
  designedSides: 1;
  trim: string;
  /** Finished size in inches — the basis for every pre-press calculation. */
  widthIn: number;
  heightIn: number;
  /** Vendor mail classes this size supports; the first is the default. */
  mailClasses: readonly ('standard' | 'first_class')[];
  minQuantity: number;
  maxQuantity: number;
  active: boolean;
}

/**
 * `46` is First-Class only — a vendor constraint, not a preference; offering Standard on it would
 * produce orders their API rejects.
 *
 * `maxQuantity` is the vendor's documented ceiling of 50,000 recipients per order.
 */
export const POSTCARD_PRODUCTS: readonly PostcardProduct[] = [
  {
    sku: '68',
    label: '6" × 8.5" postcard',
    designedSides: 1,
    trim: '6 x 8.5',
    widthIn: 6,
    heightIn: 8.5,
    mailClasses: ['standard', 'first_class'],
    minQuantity: 1,
    maxQuantity: 50_000,
    active: true,
  },
  {
    sku: '611',
    label: '6" × 11" postcard',
    designedSides: 1,
    trim: '6 x 11',
    widthIn: 6,
    heightIn: 11,
    mailClasses: ['standard', 'first_class'],
    minQuantity: 1,
    maxQuantity: 50_000,
    active: true,
  },
  {
    sku: '46',
    label: '4.25" × 6" postcard',
    designedSides: 1,
    trim: '4.25 x 6',
    widthIn: 4.25,
    heightIn: 6,
    mailClasses: ['first_class'],
    minQuantity: 1,
    maxQuantity: 50_000,
    active: true,
  },
];

/**
 * How StreetServe's margin is applied to a postcard order (ADR-007 §4, Topology B).
 *
 * `retail` means the rate is a share of what the BUYER pays: a 10% margin on a $500 order is $50 to
 * us and $450 to the vendor, so `retail = wholesale / (1 - rate)`. That reading comes from the
 * brief's own worked example — *"if a postcard order costs $500 … 10% = $50 profit"*.
 *
 * `cost` would instead mark the wholesale price up by the rate, which on the same order yields
 * $45.45 — a ~9.1% effective margin. The two differ by about a point; the basis is stated
 * explicitly rather than left to whoever reads the multiplication.
 */
export const POSTCARD_MARGIN_BASIS: 'retail' | 'cost' = 'retail';
/** How long our quote is honoured. The vendor's published price is NOT binding (audit F-8). */
export const POSTCARD_QUOTE_TTL_MINUTES = 30;

// ─── Postcard artwork / pre-press (PC-1, NF-2) ─────────────────────────────────────────────
/**
 * ⚠️ **These are commercial-print industry standards, NOT numbers confirmed by the vendor.**
 *
 * PostcardMania publishes artwork templates at pcmintegrations.com/templates, and their OpenAPI
 * document does not carry trim, bleed or resolution requirements. Rather than leave validation out
 * — which would mean discovering a bad file after the buyer paid — the standard values are used and
 * labelled as such. They are conventional enough to be safe and specific enough to be checked.
 *
 * Replace with the vendor's published figures when someone reads their template pack; every value
 * that would change lives here, and `postcards.test.ts` pins the arithmetic that depends on them.
 */
export const POSTCARD_TARGET_DPI = 300;
/**
 * Hard floor. Between this and the target the buyer is WARNED; below it the upload is REJECTED.
 *
 * A warn-only rule would be useless — the whole point is to stop a file before money moves — and a
 * reject-at-299 rule would block plenty of artwork that prints acceptably. Two thresholds is the
 * honest shape of the underlying reality.
 */
export const POSTCARD_MIN_DPI = 200;
/** Extra image beyond the trim on every edge, so a trimming tolerance never leaves a white sliver. */
export const POSTCARD_BLEED_IN = 0.125;
/** Keep text and logos this far inside the trim, or the guillotine may take them. */
export const POSTCARD_SAFE_AREA_IN = 0.125;
/** Aspect-ratio tolerance. Enough for rounding in a design tool, not enough to hide a wrong size. */
export const POSTCARD_ASPECT_TOLERANCE = 0.02;
/** 60 MB. A 300-DPI CMYK 6x11 with bleed is ~25 MB; this leaves headroom without inviting abuse. */
export const POSTCARD_MAX_ARTWORK_BYTES = 60 * 1024 * 1024;
/** Where the vendor's own press-ready templates live. Theirs, not ours — see PC-2 deferral. */
export const POSTCARD_TEMPLATES_URL = 'https://pcmintegrations.com/templates';

// ─── Postcard money (ADR-007 §4, Topology B) ───────────────────────────────────────────────
/**
 * Owner id for the print vendor's `vendor_payable` account.
 *
 * A stable string rather than a database row because there is exactly one supplier and the account
 * must exist before anyone has configured anything — the alternative is a nullable owner shared
 * with every other platform-owned account, which would merge our supplier debt into an undifferentiated
 * pool the moment a second supplier appears.
 */
export const POSTCARD_VENDOR_ACCOUNT_ID = 'vendor:postcardmania';
/**
 * How often the settlement sweep closes a period of accrued payables.
 *
 * Weekly, not nightly: the vendor bills against a retainer rather than per order, a daily statement
 * would be noise, and a human confirms each payment (see `postcard_settlements`). Frequent enough
 * that the float we carry stays visible.
 */
export const POSTCARD_SETTLEMENT_CRON = '0 5 * * 1'; // Mondays, 05:00
/**
 * Refuse to accrue more unsettled debt than this without someone looking.
 *
 * Under Topology B we hold the buyer's money and owe the vendor, so an unbounded payable balance is
 * exactly the credit exposure the topology decision accepted. A ceiling turns "we drifted" into an
 * alert. $25,000 is roughly fifty typical orders — high enough not to trip on normal weeks.
 */
export const POSTCARD_PAYABLE_ALERT_CENTS = 25_000_00;

/**
 * How often to rescue placements whose charge settled but whose webhook never arrived.
 *
 * Every 10 minutes: frequent enough that a buyer who paid does not sit staring at "Awaiting
 * payment", rare enough that it is a safety net rather than a second delivery mechanism. The
 * webhook remains the fast path; this only catches what it drops.
 */
export const PLACEMENT_PAYMENT_RECONCILE_CRON = '*/10 * * * *';

// ─── Postcard pilot (Phase 8) ──────────────────────────────────────────────────────────────
/**
 * Who may order postcards.
 *
 * `pilot` — only businesses on the ops-managed allowlist (`postcard_pilot_participants`).
 * `general` — anyone with the permission.
 *
 * **Defaults to `pilot`, and that default is the point.** This is the platform's first feature that
 * produces an irreversible physical artifact, paid for with real money, fulfilled by a third party
 * nobody has run a live order through. A bug here is not a rollback — it is paper in mailboxes. So
 * the blast radius starts at a handful of businesses somebody chose, and general availability is a
 * deliberate flip of this value once the pilot review (8.2) says the economics and the failure
 * modes are understood.
 *
 * Deliberately NOT the per-business module system: modules are archetype-driven and an owner can
 * switch them on themselves. A pilot is the opposite — ops decides who is in it.
 */
export const POSTCARD_ACCESS_MODE: 'pilot' | 'general' = 'pilot';
/**
 * Hard ceiling on a single order's charge while in pilot mode, in cents.
 *
 * A guard against our own arithmetic, not against the buyer. The integration is new and the
 * quantity flows through a vendor count we do not compute: a bug that orders 50,000 cards instead
 * of 500 is a five-figure charge on a real card. During the pilot every order is meant to be small
 * enough that a mistake is survivable, so anything above this is refused rather than charged.
 *
 * Lifted or removed when the mode flips to `general`.
 */
export const POSTCARD_PILOT_MAX_ORDER_CENTS = 100_000; // $1,000

// ─── Postcard fulfilment (Phase 6) ─────────────────────────────────────────────────────────
/**
 * How many times a submission is attempted before the order is marked failed and ops is paged.
 *
 * Retrying is safe — the vendor rejects a duplicate `extRefNbr` rather than printing twice — so the
 * limit is about how long a paid order may stay invisible, not about protecting the press. Three
 * attempts across the backoff below covers a transient outage without letting a real problem sit
 * for hours.
 */
export const POSTCARD_SUBMISSION_MAX_ATTEMPTS = 3;
/** First retry waits this long; each subsequent attempt doubles it, capped at an hour. */
export const POSTCARD_SUBMISSION_BACKOFF_MS = 60_000;
/** Submission sweep. Frequent, because it is the ONLY thing that gets a paid order to the press. */
export const POSTCARD_SUBMISSION_CRON = '* * * * *';
/**
 * Status poll. Far less often: a print run takes days, and the vendor gains nothing from being
 * asked every minute how the paper is doing.
 */
export const POSTCARD_STATUS_POLL_CRON = '*/15 * * * *';
/**
 * Return address printed on every mailing.
 *
 * USPS recommends one for First Class and does not guarantee deliverability without it. Config
 * rather than a literal because it is a business fact that changes when the company moves.
 */
export const POSTCARD_RETURN_ADDRESS = {
  company: 'StreetServe',
  address: '1000 L St',
  city: 'Modesto',
  state: 'CA',
  zipCode: '95354',
} as const;

// ─── Delivery Assist Network (ADR-004) ─────────────────────────────────────────────────────
/** Vehicle a driver works from. Recorded for dispatch suitability, never for ranking a person. */
export const DRIVER_VEHICLE_TYPES = ['bicycle', 'scooter', 'motorcycle', 'car', 'van'] as const;
export type DriverVehicleType = (typeof DRIVER_VEHICLE_TYPES)[number];

/** How long a broadcast offer stays live before it expires and re-broadcasts. */
export const DELIVERY_OFFER_TTL_SEC = 90;
/** How far the first broadcast reaches. Widened on re-broadcast rather than started wide. */
export const DELIVERY_BROADCAST_RADIUS_M = 3_000;
export const DELIVERY_BROADCAST_MAX_RADIUS_M = 8_000;
/** After this many unanswered rounds the request gives up and tells the vendor. */
export const DELIVERY_MAX_BROADCASTS = 4;

/**
 * What a vendor may offer a driver for one delivery. The VENDOR names the price and the driver sees
 * it before accepting (ADR-004): a platform-set rate the driver cannot see until afterwards is the
 * kind of control that stops an engagement being one.
 */
export const DELIVERY_MIN_PAYOUT_CENTS = 200;
export const DELIVERY_MAX_PAYOUT_CENTS = 5_000;

/**
 * A-15 — how coarse a destination looks to a driver who has not accepted yet. ~800m is enough to
 * decide whether the trip is worth taking and not enough to identify a household.
 */
export const DELIVERY_COARSE_LOCATION_M = 800;

/**
 * Server-side ceiling on courier position pings, per delivery. A client bug — or a driver with two
 * app instances open — must not be able to raise the platform's first sustained write load.
 * See SWEEP_LOAD_MODEL.md §"Realtime write load".
 */
export const DELIVERY_POSITION_MIN_INTERVAL_MS = 2_000;
/**
 * Only one position in this many is persisted; the rest are broadcast and forgotten. A 20-minute
 * delivery at the ceiling would otherwise write ~600 rows to the platform's highest-write collection,
 * and a precise minute-by-minute trace of a worker's movements is a privacy exposure as much as a
 * storage one.
 */
export const DELIVERY_POSITION_PERSIST_EVERY = 5;

/**
 * How a customer transacts with a business. EXACTLY ONE of these may be enabled: an account either
 * takes orders (goods, on the spot) or takes bookings (time, ahead) — never both.
 *
 * A dentist's account is a booking account; an accessories seller's is an ordering account. Letting
 * one account do both produced a profile with two competing primary CTAs, half of which dead-ended
 * ("this business hasn't published any bookable services yet"), and a vendor dashboard offering two
 * unrelated inboxes. The choice belongs to the business, not to the screen rendering it.
 */
export const COMMERCE_MODULES: Module[] = ['ordering', 'booking'];

/**
 * Which side wins when a business somehow holds both — its archetype's own answer, so the
 * resolution is deterministic and matches what the category already implies. `on_demand_service`
 * defaults to neither, but a mechanic taking scheduled work is booking, not ordering.
 */
export const PRIMARY_COMMERCE_BY_ARCHETYPE: Record<Archetype, Module> = {
  counter_serve: 'ordering',
  appointment_service: 'booking',
  on_demand_service: 'booking',
  goods_seller: 'ordering',
};

/**
 * A transaction module is meaningless without something to transact on, so it is only ever OFFERED
 * alongside its content module. This is what makes "Book an appointment" impossible to reach on a
 * business that has no services to book — enforced in the resolver rather than checked per screen.
 */
export const COMMERCE_REQUIRES: Record<string, Module[]> = {
  // Satisfied by ANY of the listed modules.
  booking: ['services'],
  ordering: ['menu', 'catalog'],
};

/** A business without presence or payouts isn't a business on StreetServe. */
export const CORE_MODULES: Module[] = [
  'live_presence',
  'profile',
  'reviews',
  'messaging',
  'payouts',
  'analytics',
];

// ─── Rate-limit tiers (requests / window) — SECURITY_GUIDELINES.md §4 ───────────────────────
export const RATE_LIMITS = {
  read: { windowSec: 60, max: 120 },
  write: { windowSec: 60, max: 30 },
  money: { windowSec: 60, max: 10 },
  auth: { windowSec: 60, max: 10 },
  /**
   * Endpoints that fan out to the AI provider. Far tighter than `read`: each call is metered spend
   * upstream, and Gemini's free tier caps requests per minute across the whole project — one
   * user's refresh loop must not exhaust the quota for everyone else.
   */
  ai: { windowSec: 60, max: 15 },
} as const;

// ─── TTLs ──────────────────────────────────────────────────────────────────────────────────
export const IDEMPOTENCY_TTL_SEC = 60 * 60 * 24; // 24h
export const LOCATION_RETENTION_DAYS = 30; // Q7

// ─── Notification categories that can never be fully muted (Flow 12) ───────────────────────
export const UNMUTABLE_NOTIFICATION_CATEGORIES = ['payout', 'dispute', 'verification'] as const;

/**
 * Categories a user MAY silence. Kept separate from the unmutable list above so the preference
 * endpoint can enforce that promise server-side: the client disables those switches, but a client
 * is not an authorization boundary — a crafted PATCH must not be able to mute a payout or dispute
 * alert. Default is on: notifications are opt-OUT.
 */
export const MUTABLE_NOTIFICATION_CATEGORIES = [
  'wave',
  'order',
  'message',
  /**
   * Community-network categories (Phase 2.5). All three are MUTABLE by deliberate choice.
   *
   * `generosity` is the one worth arguing about — "someone left you a free coffee" is the emotional
   * core of Pay It Forward, and there is a temptation to make it unmutable so it always lands. That
   * would be wrong twice over: an unmutable feel-good ping is indistinguishable from marketing, and
   * a category a user cannot silence is one they silence by disabling notifications entirely. Only
   * payout/dispute/verification earn that status, because missing those costs the user money.
   */
  'delivery', // driver offers, pickup/hand-off status, the customer's tracking updates
  'generosity', // a gift is available, or the fund covered your order
  'campaign', // a Boost campaign you contributed to reached its goal, or refunded
] as const;
export type MutableNotificationCategory = (typeof MUTABLE_NOTIFICATION_CATEGORIES)[number];

/**
 * Phase 7.3 — how many LIVE pushes of one mutable category a user may receive per hour.
 *
 * Not a spam control aimed at bad actors; a control aimed at ordinary product behaviour. A delivery
 * re-broadcasts up to four times to every eligible driver, and generosity events fire per gift. The
 * failure mode without a ceiling is not "a noisy hour" — it is the user disabling notifications
 * entirely, which then silences the payout and dispute alerts that are unmutable precisely because
 * missing them costs them money.
 *
 * Excess is suppressed from the live channel only. The inbox row is always written.
 */
export const NOTIFICATION_HOURLY_CEILING = 12;

/** Every category the preferences API reports, mutable or not. */
export const NOTIFICATION_PREF_CATEGORIES = [
  ...MUTABLE_NOTIFICATION_CATEGORIES,
  ...UNMUTABLE_NOTIFICATION_CATEGORIES,
] as const;

// ─── Tiered payout timing (FR-11.2) → Stripe Connect payout schedule delay (days) ──────────
// Bronze funds are held longest; Gold is the fastest the account/region allows.
export const PAYOUT_DELAY_DAYS_BY_TIER: Record<Tier, number> = {
  tier0: 7,
  bronze: 3,
  silver: 2,
  gold: 0,
};

// Which verification tier each verification_type unlocks when approved.
export const VERIFICATION_TYPE_TIER: Record<string, Tier> = {
  id_document: 'bronze',
  selfie_liveness: 'bronze',
  bank_account: 'silver',
  shelter_cosign: 'bronze',
};

export const DEFAULT_CONSIGNMENT_FEE_BPS = 1000; // 10% — mirrored by fee_schedule v1

/**
 * Typed fee registry (DEBT1). The platform charges more than one kind of fee; each is resolved
 * server-side from the versioned `fee_schedule.fees` map by fee-TYPE, so pricing (and adding a new
 * fee type) is configuration, not a code change. `marketplace`/`consignment` keep the legacy 10%.
 * See PHASE_1_IMPLEMENTATION_PLAN.md §2 and the spec's fee appendix (§31–§60).
 */
export const FEE_TYPES = [
  'marketplace', // 10% on regular + wave sales (R7)
  'consignment', // 10% on settled consignment sales (legacy consignment_fee_bps)
  'consignment_digital', // 8% — in-app card sale: collected automatically, amount verified
  'consignment_cash', // 10% — self-reported cash sale, creates an unsecured seller debt
  'rto_installment', // per-installment fee on rent-to-own (priced at RTO launch, post-MVP)
  'customer_service', // optional 3% customer-service fee, min $0.50 / max $10 (R10)
  'processing', // payment-processing pass-through, ~2.9% + 30¢ (R8)
  'setup', // one-time onboarding/setup fee
  'late', // late/overdue fee
  'promotion', // promoted-placement fee
  'booking', // platform fee on a completed service booking (§32)
  'wave_convenience', // customer-paid Waved Down convenience fee (§32.4)
  'delivery_coordination', // platform fee for arranging a delivery (DAN-8)
  'campaign_service', // service fee deducted from a FUNDED Boost campaign (ADR-006 §6)
  'postcard_margin', // StreetServe's margin on a direct postcard order (ADR-007 §4, Topology B)
] as const;
export type FeeType = (typeof FEE_TYPES)[number];

/** A resolved fee rule: a flat component + a rate component, optionally floored/capped. */
export interface FeeRule {
  rate_bps?: number;
  flat_cents?: number;
  min_cents?: number;
  max_cents?: number;
}

/**
 * Code-level fallbacks, overridden by the DB `fee_schedule.fees` registry. Only the two
 * backward-compat types carry a known launch rate here; every other type is priced purely by
 * config (seed migration / admin), which is the whole point of the registry.
 */
export const DEFAULT_FEE_RULES: Partial<Record<FeeType, FeeRule>> = {
  marketplace: { rate_bps: DEFAULT_CONSIGNMENT_FEE_BPS },
  consignment: { rate_bps: DEFAULT_CONSIGNMENT_FEE_BPS },
  /**
   * Rail-differentiated consignment pricing (Phase 2). Digital is cheaper because it genuinely
   * costs the platform less risk: the money is collected automatically and the amount is verified,
   * where a cash sale is self-reported and creates an unsecured debt. This prices the difference
   * honestly rather than policing seller behaviour.
   */
  consignment_digital: { rate_bps: 800 }, // 8%
  consignment_cash: { rate_bps: DEFAULT_CONSIGNMENT_FEE_BPS }, // 10%
  // R10: optional 3% customer-service fee, floored at $0.50 and capped at $10.
  customer_service: { rate_bps: 300, min_cents: 50, max_cents: 1000 },
  // R8: Stripe processing pass-through — 2.9% + 30¢ (US card default). DB registry may override.
  processing: { rate_bps: 290, flat_cents: 30 },
  // R26: 10% platform fee on each Rent-to-Own payment.
  rto_installment: { rate_bps: 1000 },
  /**
   * §32 booking/service fee. Same 10% as every other completed sale — a booking is a sale of a
   * service, and pricing it differently would only invite gaming the label.
   */
  booking: { rate_bps: DEFAULT_CONSIGNMENT_FEE_BPS },
  /**
   * §32.4 Waved Down convenience fee — paid by the CUSTOMER for the vendor coming to them, on top
   * of the vendor's own travel fee. Flat rather than a percentage: it prices the dispatch, which
   * costs the same whether the order is $8 or $80, and a percentage here would tax large orders for
   * a service that did not scale with them. Capped low and disclosed before the wave is confirmed.
   */
  wave_convenience: { flat_cents: 99 },
  /**
   * DAN-8 — the platform's fee for arranging a delivery. **Deliberately unpriced.**
   *
   * Flat rather than a percentage, for the reason `wave_convenience` gives directly above: it
   * prices the coordination, which costs the same whether the basket is $8 or $80, and a percentage
   * here would tax large orders for a service that did not scale with them.
   *
   * The rate is left at zero rather than guessed, because it cannot be set honestly until the driver
   * payout and the insurance cost are known — and both are Phase 5 inputs. Nothing charges this fee
   * until DAN-8 ships, so a zero here is inert. **Pricing it is a gate on DAN-8, not a follow-up.**
   */
  delivery_coordination: { flat_cents: 0 },
  /**
   * ADR-006 §6 — deducted from a Boost campaign only once it FUNDS, never from a contribution, and
   * disclosed on the campaign page before anyone gives.
   *
   * **Priced at 10% now that MB-8 is resolved** (ADR-007 §4, Topology B). Under wholesale resale
   * StreetServe's margin has to be taken somewhere, and taking it here rather than by marking up
   * the per-piece rate is the transparent choice: contributors see a disclosed line item instead of
   * an inflated postcard price.
   *
   * **Do not also mark up `BOOST_POSTCARD_SIZE_KEY`'s unit cost — that would charge the margin
   * twice.** The mailing rate is the vendor's real price; this is the only margin on a campaign.
   * `postcardEstimate` subtracts this fee before dividing, so the count a contributor is shown is
   * what their money actually buys.
   */
  campaign_service: { rate_bps: 1_000 }, // 10%
  /**
   * ADR-007 §4/§5 — this is a resale MARGIN, not a platform fee, and the distinction is recorded
   * here because the registry it lives in is otherwise entirely fees.
   *
   * A fee is deducted from a counterparty's proceeds and disclosed to them. This is embedded in the
   * retail price of something StreetServe buys wholesale and resells: the buyer sees one price for
   * a mailing, not a cost plus a fee. It lives in the registry anyway so the rate is
   * admin-adjustable from one place, and because the transcript anticipates it moving with volume.
   *
   * Applied per `POSTCARD_MARGIN_BASIS` (retail, not cost-plus).
   */
  postcard_margin: { rate_bps: 1_000 }, // 10%
};

// ─── Phase 2: live map, wave-down, queue (FR-1..FR-4) ──────────────────────────────────────
export const GEOHASH_PRECISION = 6; // ~1.2km cell for bucketed subscriptions
export const LIVE_SESSION_TTL_SEC = 60; // no ping past this → session considered stale
export const LOCATION_SNAPSHOT_INTERVAL_SEC = 10; // FR-1.2 min server-side update cadence

export const WAVE_DOWN_SLA_DEFAULT_SEC = 300; // 5 min
export const WAVE_DOWN_SLA_MIN_SEC = 120; // 2 min
export const WAVE_DOWN_SLA_MAX_SEC = 900; // 15 min

export const QUEUE_HOLD_DEFAULT_SEC = 900; // 15 min geofence-leave hold (FR-3.4)

/**
 * Trending ranking (R1b). Signals are normalized to 0–1 then weighted — the same shape as
 * `AI_WEIGHTS` in the rule-based engine, and equally explainable (each result carries its factors).
 *
 * A discount is a **boost, never a gate**: a vendor with no discount schedule still ranks on demand,
 * recency, and proximity — they just forgo the largest single weight. That is exactly the R1
 * "discounts are optional but rewarded" incentive, made measurable.
 */
export const TRENDING_WEIGHTS = {
  discount: 0.35,
  demand: 0.3,
  recency: 0.2,
  proximity: 0.15,
} as const;
export const TRENDING_DISCOUNT_REF_PERCENT = 25; // a 25% best-available discount saturates the boost
export const TRENDING_DEMAND_REF_QUEUE = 8; // 8 people in line saturates the demand signal
export const TRENDING_RECENCY_HALFLIFE_MIN = 45; // freshness half-life on last_ping_at
export const TRENDING_PROX_MAX_M = 20_000; // proximity falls off to 0 beyond ~20km
export const TRENDING_MAX_CANDIDATES = 200; // live sessions scored per request
export const TRENDING_DEFAULT_LIMIT = 10;

/**
 * ═══ PHASE C — MAP LAYERS ═══
 *
 * The product is map-first, and until now the map showed exactly one thing: live business sessions.
 * Consignment hubs — the supply side of the whole seller economy — were discoverable only through a
 * list, and the demand signals the platform already collects (wave-downs, queue joins) were never
 * drawn at all.
 */
/** Max hubs returned for one viewport. Hubs are static, so this is generous. */
export const MAP_HUBS_MAX = 300;

/**
 * DEMAND TILES (C-3). Wave-downs and queue entries carry no coordinates of their own — they point
 * at an OWNER. So demand is located at the owner's live position and bucketed into a grid.
 *
 * Grid size is in degrees rather than metres deliberately: a fixed-degree bucket is stable across
 * requests (the same event always lands in the same tile regardless of viewport), which is what
 * makes the layer flicker-free while panning. ~0.005° ≈ 550m at the equator, tightening with
 * latitude — close enough to "a few blocks" everywhere the platform operates.
 */
export const DEMAND_TILE_DEGREES = 0.005;
/** How far back demand counts. Short: this is "where people want something NOW", not history. */
export const DEMAND_WINDOW_HOURS = 6;
/** Tiles returned per viewport; beyond this the layer is noise rather than signal. */
export const DEMAND_MAX_TILES = 400;
/**
 * A tile needs at least this much demand to be drawn. One person waving once is not a hot zone, and
 * rendering it as one would make the layer untrustworthy — and would deanonymise that person's
 * approximate location to anyone watching the map.
 */
export const DEMAND_MIN_TILE_WEIGHT = 2;
/**
 * Relative weights. A queue join is a stronger commitment than a wave-down: the customer is already
 * in line and has locked a discount, where a wave is a request that may go unanswered.
 */
export const DEMAND_WEIGHT_QUEUE_JOIN = 2;
export const DEMAND_WEIGHT_WAVE_DOWN = 1;

/**
 * ═══ PHASE E — REAL AI ═══
 *
 * A note on what "forecast" means here, because the word is doing a lot of work in the brief.
 *
 * `ForecastEngine` is a STATISTICAL forecaster, not a machine-learning model: recency-weighted
 * historical sell-through per (category × tile × hour), adjusted by weather, calendar and event
 * multipliers. Every number it produces is traceable to rows in `outcome_facts` and a small set of
 * documented coefficients.
 *
 * That is a deliberate choice, not a shortcut. A trained model needs a labelled dataset that only
 * started existing with E-1, and shipping an unvalidated model would mean replacing an explainable
 * ranking with an opaque one on no evidence. The `RecommendationEngine` seam means swapping in a
 * trained model later is one `setRecommendationEngine()` call — and by then `outcome_facts` will
 * have the history to validate it against.
 */
export const FORECAST_ENGINE_VERSION = 'forecast-v1';
/** Outcome rows older than this stop counting. Street demand turns over fast. */
export const FORECAST_WINDOW_DAYS = 90;
/** Half-life for recency weighting, in days — a sale last week outweighs one two months ago. */
export const FORECAST_RECENCY_HALFLIFE_DAYS = 21;
/**
 * Observations in a (category × tile × hour) cell below which the cell's own rate is not trusted on
 * its own and is blended toward the category-wide prior. Without this, one lucky sale in an empty
 * cell reads as a 100% sell-through forecast.
 */
export const FORECAST_MIN_CELL_OBSERVATIONS = 4;
/** Laplace-style prior strength when blending a thin cell toward its category average. */
export const FORECAST_PRIOR_WEIGHT = 6;
/** Fallback sell-through when there is no evidence at all — deliberately pessimistic, not neutral. */
export const FORECAST_BASELINE_SELL_THROUGH = 0.25;

export const FORECAST_WEIGHTS = {
  /** The forecast itself — predicted sell-through for this product in this cell. */
  demand: 0.45,
  /** D-2 skill/venue match (E-7). */
  affinity: 0.2,
  /** A-4's acceptance signal, retained. */
  acceptance: 0.12,
  proximity: 0.13,
  /** E-4: a nearby event with real attendance. */
  event: 0.1,
} as const;

// ── E-2 weather cache ──
/** ~5km. Coarser than the demand tile on purpose — weather doesn't vary at demand resolution. */
export const WEATHER_CACHE_TILE_DEGREES = 0.05;
export const WEATHER_CACHE_TTL_MIN = 60;

// ── E-4 events ──
export const EVENT_SOURCES = ['manual', 'ticketmaster', 'eventbrite'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];
/** How close an event must be to a hub/seller to count as "nearby". */
export const EVENT_NEARBY_RADIUS_M = 3_000;
/** Attendance that saturates the event signal — beyond this, bigger stops meaning better. */
export const EVENT_ATTENDANCE_REF = 2_000;
/** How far ahead E-5 alerts sellers. Long enough to plan, short enough to still be actionable. */
export const EVENT_ALERT_LEAD_HOURS = 24;
/** One alert per seller per event, ever — this is a nudge, not a drumbeat. */
export const EVENT_ALERT_MIN_ATTENDANCE = 150;

// ── E-9 Income Coach ──
/** Plans above this are refused rather than fabricated — see `incomeCoach`. */
export const COACH_MAX_GOAL_CENTS = 100_000; // $1,000
export const COACH_DEFAULT_GOAL_CENTS = 10_000; // $100 — the brief's own example
/** Items in a generated basket. More than this is a shopping list, not a plan. */
export const COACH_MAX_BASKET_ITEMS = 6;

export const PROXIMITY_ALERT_THROTTLE_SEC = 7200; // 1 alert / vendor / user / 2h (FR-1.4)
export const PROXIMITY_HOME_RADIUS_M = 2000; // default home-area radius for proximity alerts

export const NEARBY_DEFAULT_RADIUS_M = 3000;
export const NEARBY_MAX_RADIUS_M = 20000;

// ─── Phase 3: scheduling, orders, messaging (FR-7, Flow 2d/2c) ──────────────────────────────
export const BOOKING_CUTOFF_DEFAULT_MIN = 120; // reschedule/cancel cutoff before scheduled time
export const BOOKING_REMINDER_24H_SEC = 24 * 60 * 60;
export const BOOKING_REMINDER_1H_SEC = 60 * 60;
export const MESSAGE_MAX_LEN = 2000;

// ─── Phase 4: consignment, trust, disputes (FR-8, FR-10) ────────────────────────────────────
export const SELLER_AGREEMENT_VERSION = 'v1-2026-07'; // clickwrap bailment agreement (FR-8.6)
export const RETURN_GRACE_HOURS = 24; // grace after expected_return_at before penalty (FR-8.5)

// ─── Consignment agreement lifecycle (R14/R15/R17/R18) ──────────────────────────────────────
/** Allowed consignment term durations, in days. `no_limit` is a separate string term. */
/**
 * Hub checkout auto-approval defaults (H-03 / FR-8.4). A reservation clears automatically only when
 * the seller is trusted AND the declared value is within the cap — so a hub isn't rubber-stamping
 * trusted repeat sellers all day, but never sleepwalks into handing over high-value stock either.
 * Both are per-hub configurable; a null cap means "no value limit".
 */
export const DEFAULT_AUTO_APPROVE_MIN_TRUST = 85;
export const DEFAULT_AUTO_APPROVE_MAX_VALUE_CENTS = 20_000; // $200

export const CONSIGNMENT_TERM_DAYS = [7, 14, 30, 60, 90, 180, 365] as const;
export const DEFAULT_CONSIGNMENT_TERM_DAYS = 30;
/** Days-before-expiry to notify the seller, plus 0 = on the expiry date (R15). */
export const CONSIGNMENT_EXPIRY_NOTICE_DAYS = [14, 7, 3, 0] as const;
/** Return-Pending defaults (R17): who returns, the window, per-day storage, abandonment cutoff. */
export const DEFAULT_RETURN_WINDOW_DAYS = 14; // spec: 7–14 days
export const MIN_RETURN_WINDOW_DAYS = 7;
export const MAX_RETURN_WINDOW_DAYS = 14;
export const DEFAULT_ABANDONMENT_AFTER_DAYS = 30; // never auto-keep before this, and only if lawful

/**
 * §37 — TERMINATION NOTICE.
 *
 * Either party may end a consignment, but not instantly: the other side has stock on a shelf or
 * goods in a van, and needs time to react. The spec ties the period to what is being moved — 3 days
 * for low-value goods, 7 for standard, 14–30 for expensive or specialised — because recalling a
 * crate of candles and recalling a commercial oven are not the same favour to ask.
 *
 * Derived from declared value at checkout and snapshotted, exactly like `return_window_days`, so a
 * later re-tune of these bands cannot change the deal someone already agreed to.
 */
export const TERMINATION_NOTICE_LOW_DAYS = 3;
export const TERMINATION_NOTICE_STANDARD_DAYS = 7;
export const TERMINATION_NOTICE_HIGH_DAYS = 14;
export const MAX_TERMINATION_NOTICE_DAYS = 30;
/** Value bands, in cents of total declared consignment value. */
export const TERMINATION_NOTICE_LOW_MAX_CENTS = 10_000; // ≤ $100 → 3 days
export const TERMINATION_NOTICE_STANDARD_MAX_CENTS = 50_000; // ≤ $500 → 7 days

/** The notice period this consignment carries, from its total declared value (§37). */
export function terminationNoticeDaysFor(totalValueCents: number): number {
  if (totalValueCents <= TERMINATION_NOTICE_LOW_MAX_CENTS) return TERMINATION_NOTICE_LOW_DAYS;
  if (totalValueCents <= TERMINATION_NOTICE_STANDARD_MAX_CENTS) {
    return TERMINATION_NOTICE_STANDARD_DAYS;
  }
  return TERMINATION_NOTICE_HIGH_DAYS;
}

/**
 * §39 — AUTOMATIC RENEWAL.
 *
 * Off unless both parties agreed to it (§38 is explicit that nothing auto-renews otherwise), and
 * even then it is announced before it happens and either party can switch it off up to the moment
 * it fires. A renewal that arrives unannounced is the thing subscription law exists because of.
 */
export const CONSIGNMENT_RENEWAL_TERMS = [7, 30, 60, 90] as const;
/** `until_sold` keeps renewing while stock remains; the day-values renew for that many days. */
export type ConsignmentRenewalTerm = (typeof CONSIGNMENT_RENEWAL_TERMS)[number] | 'until_sold';
/** Days before expiry that the "this will renew" notice fires. Inside the §38 notice ladder. */
export const CONSIGNMENT_RENEWAL_NOTICE_DAYS = 3;

/**
 * LISTING TYPES (A-1). The enum has always accepted four values, but only ONE of them has a
 * lifecycle: checkout, sale logging, return and `settle()` all implement consignment and nothing
 * else. A `rental` listed today would settle as a sale and never return its deposit; a `donation`
 * would split revenue with a seller who was never owed any. The field was inert metadata sitting
 * directly upstream of the money path.
 *
 * So the enum stays (the shapes are real product intent and the stored values must keep meaning
 * what they meant), and `SUPPORTED_LISTING_TYPES` is the gate: creation and checkout accept only
 * what the settlement code can actually honour. Each type joins this list when — and only when —
 * its own path exists:
 *   wholesale → seller pays the hub upfront and keeps 100% of the resale
 *   rental    → deposit hold, duration-based accrual, damage assessed against the deposit
 *   donation  → no seller split; proceeds route to the listing owner or named beneficiary
 */
export const LISTING_TYPES = ['consignment', 'wholesale', 'rental', 'donation'] as const;
export type ListingType = (typeof LISTING_TYPES)[number];
export const SUPPORTED_LISTING_TYPES: readonly ListingType[] = ['consignment'];
export function isSupportedListingType(value: string | null | undefined): boolean {
  return SUPPORTED_LISTING_TYPES.includes((value ?? 'consignment') as ListingType);
}
/** Human-readable label for the refusal message. */
export const LISTING_TYPE_LABELS: Record<ListingType, string> = {
  consignment: 'Consignment',
  wholesale: 'Wholesale',
  rental: 'Rental',
  donation: 'Donation',
};

/**
 * FOOD JURISDICTION GATING (A-6). Selling prepared food, snacks or drinks from a hub's inventory is
 * a permitted activity nearly everywhere in the US — cottage-food laws, health-department permits
 * and temporary-event food licences all vary by county. The platform cannot know a jurisdiction's
 * rules, so it must not assume permission: food categories are DENIED unless the hub's city has
 * been explicitly cleared via `City.feature_flags.consignment_food === true`.
 *
 * Note this deliberately does NOT use `platformService.isFeatureEnabled`, which defaults OPEN for
 * unconfigured cities (the right call for pilot rollout of ordinary features). Food needs
 * `isFeatureExplicitlyEnabled`: a hub with no `city_slug`, or in a city nobody has reviewed, cannot
 * list food. An unknown jurisdiction is not a permissive one.
 */
export const FOOD_CATEGORY_SLUGS = [
  'food',
  'coffee',
  'snacks',
  'drinks',
  'produce',
  'bakery',
] as const;
/** City feature flag that clears a jurisdiction for consignment food sales. */
export const FOOD_SALES_FEATURE_FLAG = 'consignment_food';

// ─── Rent-to-Own (R20–R27) — jurisdiction-gated (City.feature_flags.rto), compliance-cleared ─
export const RTO_FREQUENCIES = [
  'daily',
  'weekly',
  'biweekly',
  'twice_monthly',
  'monthly',
  'custom',
] as const;
export type RtoFrequency = (typeof RTO_FREQUENCIES)[number];
/** Days between installments per frequency (twice_monthly ≈ 15d; custom carries its own interval). */
export const RTO_FREQUENCY_DAYS: Record<Exclude<RtoFrequency, 'custom'>, number> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
  twice_monthly: 15,
  monthly: 30,
};
/** Grace period (days) before a missed installment goes Late, by frequency (R22). */
export const RTO_GRACE_DAYS: Record<Exclude<RtoFrequency, 'custom'>, number> = {
  daily: 1,
  weekly: 3,
  biweekly: 5,
  twice_monthly: 5,
  monthly: 7,
};
/**
 * §43 — categories that can NEVER be offered on the standard Rent-to-Own programme, whatever an
 * admin ticks. The spec is explicit that vehicles and other specially regulated products need a
 * separately reviewed programme, and a compliance rule that a single mis-click can switch off is
 * not a compliance rule. Matched against the category slug and its regulator.
 */
export const RTO_PROHIBITED_CATEGORY_SLUGS = [
  'vehicles',
  'auto_sales',
  'motorcycles',
  'firearms',
  'alcohol',
  'tobacco',
  'cannabis',
  'pharmacy',
  'medical_devices',
  'financial_services',
] as const;

/**
 * §49 — the five moments a rent-to-own customer must hear from us: BEFORE the payment is due, ON
 * the due date, DURING the grace period, WHEN it becomes late, and BEFORE any recovery action.
 *
 * Recorded as named stages rather than day offsets because the spec is about the customer's
 * situation, not the calendar: "you have three days left of your grace period" and "you are now
 * late" are different messages even when they land a day apart, and a customer who only ever hears
 * the last one has been ambushed.
 */
export const RTO_REMINDER_STAGES = [
  'upcoming',
  'due_today',
  'grace',
  'late',
  'pre_recovery',
] as const;
export type RtoReminderStage = (typeof RTO_REMINDER_STAGES)[number];
/** Days before the due date that the first reminder fires. */
export const RTO_REMINDER_LEAD_DAYS = 3;
/** Days after `late` before recovery is warned about — the last chance to talk to us. */
export const RTO_PRE_RECOVERY_DAYS = 7;

export const RTO_SETUP_FEE_MIN_CENTS = 500; // $5 (R26, optional)
export const RTO_SETUP_FEE_MAX_CENTS = 2500; // $25
export const RTO_MAX_INSTALLMENTS = 104; // ~2y weekly ceiling (sanity bound)

// ─── Monetization: subscription plans (R29/R30) ─────────────────────────────────────────────
/**
 * ═══ PHASE F — MONETIZATION BREADTH ═══
 *
 * Four existing plans become seven. The two new subscriptions (`seller_plus`, `stock_waiver`) are
 * SELLER-scoped, which is the gap the brief identified: every existing plan sells to a business,
 * and the platform's largest population — individual consignment sellers — had nothing to buy and
 * nothing to gain by paying.
 */
export const SUBSCRIPTION_PLANS = [
  'pro',
  'featured',
  'verified_badge',
  'ai_assistant',
  'seller_plus',
  'stock_waiver',
] as const;
export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];

export interface SubscriptionPlanDef {
  plan: SubscriptionPlan;
  name: string;
  priceCents: number; // monthly
  blurb: string;
  /** Business-scoped (seller/vendor offering) vs user-scoped. */
  scope: 'business' | 'user';
}
export const SUBSCRIPTION_PLAN_DEFS: Record<SubscriptionPlan, SubscriptionPlanDef> = {
  pro: {
    plan: 'pro',
    name: 'StreetServe Pro',
    priceCents: 2999, // $29.99/mo (within the $19.99–$99 band)
    blurb: 'Lower marketplace fees on every sale, plus priority support.',
    scope: 'business',
  },
  featured: {
    plan: 'featured',
    name: 'Featured Placement',
    priceCents: 4999,
    blurb: 'Rise to the top of Trending and discovery.',
    scope: 'business',
  },
  verified_badge: {
    plan: 'verified_badge',
    name: 'Verified Badge',
    priceCents: 999,
    blurb: 'A verified badge on your profile and pins.',
    scope: 'business',
  },
  ai_assistant: {
    plan: 'ai_assistant',
    name: 'AI Marketing Assistant',
    priceCents: 1999,
    blurb: 'Unlimited AI coaching, pricing, and marketing copy.',
    scope: 'user',
  },
  /**
   * F-2 — the seller membership the brief promised and the plan set never had. Priced an order of
   * magnitude below the business plans because it is sold to someone whose whole proposition is
   * "start with no money": $4.99 has to be recoverable in a single good afternoon, or the plan is
   * just a tax on the people least able to pay it.
   */
  seller_plus: {
    plan: 'seller_plus',
    name: 'Seller Plus',
    priceCents: 499,
    blurb: 'Carry more stock, keep more of each sale, and get first look at new inventory.',
    scope: 'user',
  },
  /**
   * F-4 — a DAMAGE WAIVER, deliberately not insurance. See `WAIVER_*` below for why that
   * distinction is load-bearing rather than cosmetic.
   */
  stock_waiver: {
    plan: 'stock_waiver',
    name: 'Stock Protection',
    priceCents: 299,
    blurb: 'If stock is lost or damaged, we waive what you’d owe — up to your cover limit.',
    scope: 'user',
  },
};
/** Pro's marketplace-fee discount: 3 points off (10% → 7%). Config-overridable via membership_overrides. */
export const PRO_MARKETPLACE_DISCOUNT_BPS = 300;
/** Additive boost applied to a Featured subscriber's Trending score (0–1 scale). */
export const FEATURED_TRENDING_BOOST = 0.4;

/**
 * ═══ F-1 — FEATURED PRODUCTS & HUBS ═══
 *
 * `featured` already boosted a BUSINESS in Trending. It could not promote a product or a hub, which
 * are the two things a consignment owner actually wants seen.
 *
 * Featured placement is a boost, never a filter — the same rule the discount signal follows in
 * Trending. Paid placement that could BURY organic results would make discovery untrustworthy, and
 * a marketplace nobody trusts to rank honestly is worth less than the placement fees.
 */
export const FEATURED_PRODUCT_BOOST = 0.25;
export const FEATURED_HUB_BOOST = 0.3;
/** Featured slots sold per (city, surface). A scarce inventory is what makes it worth buying. */
export const FEATURED_MAX_SLOTS_PER_CITY = 6;
/** Featured placements are always disclosed. Non-negotiable — see `FEATURED_LABEL`. */
export const FEATURED_LABEL = 'Promoted';

/**
 * ═══ F-2 — SELLER PLUS PERKS ═══
 *
 * Real, enforced perks rather than marketing copy — each maps to code that already gates something:
 *  • inventory ceiling multiplier, applied alongside the A-3 Trust band
 *  • a consignment fee discount, funded (like A-3's) from the PLATFORM's own cut, never the hub's
 *  • early access to newly listed stock
 */
export const SELLER_PLUS_INVENTORY_MULTIPLIER = 1.5;
/** Basis points off the platform's consignment fee. Stacks with the A-3 Trust band discount. */
export const SELLER_PLUS_FEE_DISCOUNT_BPS = 1500;
/** Hours a new product is visible to Plus members before everyone else. */
export const SELLER_PLUS_EARLY_ACCESS_HOURS = 12;

/**
 * ═══ F-4 — STOCK PROTECTION: A WAIVER, NOT INSURANCE ═══
 *
 * ⚠ READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * This is a CONTRACTUAL WAIVER of the platform's own right to recover, not an insurance product.
 * The distinction is legal, not cosmetic:
 *
 *   • INSURANCE indemnifies someone against third-party risk in exchange for a premium. Selling it
 *     requires a licensed carrier or MGA relationship, state-by-state producer licensing, and filed
 *     rates and forms. A platform that charges a premium and pays claims IS an insurer.
 *   • A WAIVER is us agreeing not to collect a debt WE would otherwise be owed. That is a term of
 *     the consignment agreement — the same mechanism rental marketplaces use for damage cover.
 *
 * So the implementation must never:
 *   • pay out money to the seller (that would be a claim against a policy),
 *   • cover anything other than what the seller would owe US,
 *   • use the words "insurance", "policy", "premium", "claim" or "covered peril" in user copy.
 *
 * What it does: when loss/damage would create a debt under `chargeInventoryLiability`, an active
 * waiver suppresses that debt up to the cap. The hub is still made whole — the platform absorbs it.
 * That is the cost of the product, and it is why the cap is low and the exclusions are real.
 */
export const WAIVER_COVER_CAP_CENTS = 15_000; // $150 per incident
/** Rolling window and cap on total waived value — stops the waiver becoming free inventory. */
export const WAIVER_PERIOD_DAYS = 30;
export const WAIVER_PERIOD_CAP_CENTS = 30_000; // $300 per 30 days
/**
 * Waiting period before a new waiver is active. Without it someone subscribes AFTER losing stock and
 * the product becomes a way to convert a debt into $2.99 — adverse selection in its purest form.
 */
export const WAIVER_WAITING_PERIOD_HOURS = 48;
/**
 * `lost` stock is waived; `damaged` is waived at half, matching the liability rate. Deliberate
 * exclusions, stated plainly to the seller before purchase rather than buried:
 *   • stock never returned at all (that is abandonment, not loss)
 *   • a seller with an upheld dispute in the period
 */
export const WAIVER_DAMAGED_RATE = 0.5;

/**
 * ═══ F-3 — AD INVENTORY ═══
 *
 * Replaces the sponsors module's manual logo placement + spreadsheet reporting with real,
 * billable, targeted inventory.
 *
 * Priced CPM rather than CPC on purpose: a click-priced ad on a map surface rewards whatever is
 * most tappable, which in this product means whatever most resembles a live vendor pin — precisely
 * the confusion between paid and organic that `FEATURED_LABEL` exists to prevent.
 */
export const AD_PLACEMENTS = ['map_banner', 'discovery_card', 'earn_slot'] as const;
export type AdPlacement = (typeof AD_PLACEMENTS)[number];
/** Default price per thousand impressions, per placement. */
export const AD_CPM_CENTS: Record<AdPlacement, number> = {
  map_banner: 1_200,
  discovery_card: 900,
  earn_slot: 700,
};
/** An ad never occupies more than this share of a feed — the rest stays organic. */
export const AD_MAX_SHARE_OF_FEED = 0.2;
/** Impressions are billed in batches so a feed render isn't a write per ad. */
export const AD_IMPRESSION_BATCH = 25;

/**
 * ═══ FLAT PROMOTION TIERS (spec §32) ═══
 *
 * CPM is the more precise model and it stays — but a street vendor deciding whether to spend $5
 * today cannot price a CPM campaign, and pricing they cannot reason about is pricing they do not
 * buy. These are the accessible on-ramp: one flat price, one window, no arithmetic.
 *
 * Internally a tier is still metered. The flat price becomes the campaign's BUDGET and the tier
 * length becomes its window, so delivery stops at whichever comes first. That is what keeps the
 * promise bounded in both directions: the buyer can never be over-delivered against a price they
 * already paid, and the platform can never owe impressions it did not sell.
 */
export const AD_DURATION_TIERS = [
  { days: 1, priceCents: 500, label: 'One day' },
  { days: 7, priceCents: 1500, label: 'One week' },
  { days: 30, priceCents: 4000, label: 'One month' },
] as const;
export type AdDurationTier = (typeof AD_DURATION_TIERS)[number];
export const AD_TIER_DAYS = AD_DURATION_TIERS.map((t) => t.days) as unknown as number[];

/**
 * Shown on every promotion purchase, verbatim from spec §32: "Promoted placement does not guarantee
 * sales." Selling visibility while implying outcomes is how ad products lose the trust that makes
 * them worth anything — and this is the sentence a disappointed vendor will quote back.
 */
export const AD_PROMO_DISCLOSURE =
  'Promoted placement increases how often people see this. It does not guarantee sales, and it never ' +
  'pushes other businesses out of results — promoted items are always labelled and capped at a share ' +
  'of what anyone sees.';
/**
 * CU-30 — reports needed before a review's PHOTOS are auto-hidden pending review. Low, because an
 * explicit or hostile image sitting on a vendor's profile is worse for everyone than a wrongly
 * hidden photo, and the review's rating and words are never affected either way.
 */
export const REVIEW_PHOTO_REPORT_THRESHOLD = 2;
export const MAX_REVIEW_PHOTOS = 6;

export const DISPUTE_SLA_DAYS = 5; // business-day target (FR-10.2)
/**
 * v2 (Phase 3): trust is EARNED, not granted. v1 scored a brand-new seller with zero history at
 * 100/100, so a fresh account cleared every auto-approval instantly — the signal was inverted.
 * v2 starts newcomers low and converges on the behavioural formula as real completions accumulate.
 */
export const TRUST_FORMULA_VERSION = 'v2';
/** Score for a seller with no computed record at all. */
export const TRUST_DEFAULT_SCORE = 40;
/** Where a seller begins before any completed consignment. */
export const TRUST_STARTING_SCORE = 40;
/** Completed returns after which the behavioural formula is trusted at full weight. */
export const TRUST_CONFIDENCE_COMPLETIONS = 5;

/**
 * Trust-tier credit limits (Phase 3). Trust becomes the seller's CREDIT RATING: how much
 * uncollateralised inventory value they may hold at once, and how much cash debt they may carry
 * before they must clear it. This is the graduated-credit model proven by micro-finance with
 * exactly this demographic — see docs/consignment/RECOMMENDED_BUSINESS_MODEL.md.
 */
export interface CreditLimit {
  /** Max total declared value of stock held across active checkouts. */
  maxInventoryValueCents: number;
  /** Max outstanding cash-sale debt before new checkouts are blocked. */
  maxCashDebtCents: number;
}
export const CREDIT_LIMITS_BY_TIER: Record<Tier, CreditLimit> = {
  tier0: { maxInventoryValueCents: 0, maxCashDebtCents: 0 }, // unverified: cannot check out
  bronze: { maxInventoryValueCents: 20_000, maxCashDebtCents: 10_000 }, // $200 / $100
  silver: { maxInventoryValueCents: 100_000, maxCashDebtCents: 40_000 }, // $1,000 / $400
  gold: { maxInventoryValueCents: 500_000, maxCashDebtCents: 150_000 }, // $5,000 / $1,500
};

/**
 * TRUST BANDS (A-3). Until now the Trust Score was computed carefully and then consumed by almost
 * nothing — only hub auto-approval read it. A score nobody is paid for is a score nobody works for,
 * so these bands turn it into three concrete, earnable benefits:
 *
 *   1. `inventoryMultiplier` — how much stock the seller may hold, as a multiple of their TIER cap.
 *   2. `feeDiscountBps`      — a discount on the platform's own consignment fee, paid ENTIRELY to
 *                              the seller (see `settle()`), so the hub's authored split is untouched.
 *   3. `premiumEligible`     — access to products a hub has gated behind `min_seller_trust_score`.
 *
 * WHY THE FEE DISCOUNT AND NOT A BIGGER SPLIT: the split percentage belongs to the hub owner — it
 * is their authored term, snapshotted onto the checkout. The platform must never quietly move
 * someone else's money to fund its own loyalty programme. Discounting our OWN fee is the only
 * reward we are entitled to give away.
 *
 * WHY THE MULTIPLIER CANNOT REPLACE KYC: `KYC_REQUIREMENT_BY_VALUE` still binds independently and
 * is checked after this. A high-trust seller with a thin identity file gets a larger ceiling from
 * their band and is still stopped by the KYC ladder — trust measures behaviour, not identity, and
 * only one of those satisfies a regulator.
 *
 * WHY NO MULTIPLIER IS BELOW 1.0: trust is upside only. A sub-1.0 band would shrink the tier
 * ceiling for low scores, and the people sitting at a low score are overwhelmingly NEW — the v2
 * confidence ramp deliberately starts everyone at the floor until they have a record. Multiplying
 * their limit down would punish them a second time for the same absence of history, and it would
 * cut the stock a brand-new Bronze seller can take from $200 to $100 on their first day. That is
 * the exact funnel the platform exists to open. Bad behaviour is already handled where it belongs:
 * the score itself falls, auto-approval stops, and debt escalation blocks new checkouts outright.
 *
 * Ordered ascending; resolve with `trustBandFor()`.
 */
export interface TrustBand {
  key: 'building' | 'established' | 'trusted' | 'elite';
  label: string;
  /** Inclusive lower bound of the band. */
  minScore: number;
  /** Multiplier applied to the tier's `maxInventoryValueCents`. */
  inventoryMultiplier: number;
  /** Discount on the platform consignment fee, in basis points of the fee itself. */
  feeDiscountBps: number;
  /** May take products a hub has gated behind a minimum trust score. */
  premiumEligible: boolean;
}
export const TRUST_BANDS: readonly TrustBand[] = [
  {
    key: 'building',
    label: 'Building',
    minScore: 0,
    // Same ceiling as `established` by design — see "WHY NO MULTIPLIER IS BELOW 1.0" above. The
    // band still differs in what it says to the seller and in what the next one unlocks.
    inventoryMultiplier: 1,
    feeDiscountBps: 0,
    premiumEligible: false,
  },
  {
    key: 'established',
    label: 'Established',
    minScore: 40,
    inventoryMultiplier: 1,
    feeDiscountBps: 0,
    premiumEligible: false,
  },
  {
    key: 'trusted',
    label: 'Trusted',
    minScore: 65,
    inventoryMultiplier: 1.5,
    feeDiscountBps: 1000, // 10% off the platform fee
    premiumEligible: true,
  },
  {
    key: 'elite',
    label: 'Elite',
    minScore: 85,
    inventoryMultiplier: 2,
    feeDiscountBps: 2500, // 25% off the platform fee
    premiumEligible: true,
  },
] as const;

/** Resolve the band a score falls in. Always returns a band — the lowest is unbounded below. */
export function trustBandFor(score: number): TrustBand {
  let band = TRUST_BANDS[0]!;
  for (const b of TRUST_BANDS) if (score >= b.minScore) band = b;
  return band;
}

/** The band immediately above `band`, or null at the top. Drives "what unlocks next" copy. */
export function nextTrustBand(band: TrustBand): TrustBand | null {
  const i = TRUST_BANDS.findIndex((b) => b.key === band.key);
  return TRUST_BANDS[i + 1] ?? null;
}

/** Days a cash-sale debt may sit before escalation blocks new inventory. */
export const DEBT_DUE_DAYS = 14;

/**
 * KYC scaled to value at risk (Phase 5). Identity assurance should be proportional to what someone
 * is trusted with — holding $5,000 of a hub's stock warrants more than holding $50. These floors
 * sit alongside the credit limits: the tier caps the VALUE, this states what identity that tier
 * required in the first place.
 */
export const KYC_REQUIREMENT_BY_VALUE: Array<{
  aboveCents: number;
  minTier: Tier;
  requires: string;
}> = [
  { aboveCents: 0, minTier: 'bronze', requires: 'Government ID' },
  { aboveCents: 20_000, minTier: 'silver', requires: 'Government ID + linked bank account' },
  { aboveCents: 100_000, minTier: 'gold', requires: 'Full identity verification' },
];

/**
 * US federal 1099-K reporting threshold. Stripe issues the form for payouts it processes; this is
 * used to warn a seller before they cross it, so it is never a surprise.
 */
export const TAX_1099K_THRESHOLD_CENTS = 60_000_00; // $600
// Reservation-limit reduction applied on an overdue/defaulted checkout (Trust penalty side effect).
export const OVERDUE_RESERVATION_PENALTY = 1;

// ─── Phase 5: growth mechanics (FR-4.2, FR-5, FR-6) ─────────────────────────────────────────
export const PING_DAILY_CAP = 10; // tip-eligible shares per sender per day (FR-5.3)
export const PING_QUALIFY_WINDOW_HOURS = 24; // recipient must qualify within this window (FR-5.2)
export const NEW_ACCOUNT_WINDOW_DAYS = 90; // "new or 90-day-dormant" recipient eligibility (FR-5.2)
export const GIFT_EXPIRY_DAYS = 14; // default gift redemption window (FR-6.1)
export const GIFT_EXPIRY_NOTICE_HOURS = 48; // notify sender before expiry (FR-6.1)
export const SPOT_ME_MIN_ACCOUNT_AGE_DAYS = 30; // Spot Me gate (Business Rules §3)
export const BLOCK_PARTY_RADIUS_M = 150; // cluster radius (FR-4.2)
export const BLOCK_PARTY_MIN_OVERLAP_MS = 10 * 60 * 1000; // sustained window (FR-4.2)
export const BLOCK_PARTY_BROADCAST_RADIUS_M = 1609; // ~1 mile broadcast (FR-4.2)

// ─── Static hub QR sunset (roadmap 6.5) ─────────────────────────────────────────────────────
/**
 * The date the old static hub QR stops being accepted **everywhere**, whatever any hub's flag or
 * per-hub deadline says.
 *
 * `allow_static_qr` was introduced as grandfathering for hubs that had printed the pre-rotation
 * poster, on the understanding that they would be chased down and switched off. Nothing forced
 * that: a flag with no deadline is a permanent exception wearing a temporary one's clothes, and
 * every hub still on it is one photographed poster away from someone reserving stock from their
 * sofa — which defeats the only proof of physical presence in the whole custody model.
 *
 * So the phase-out is a DATE, not an intention. Per-hub deadlines can be shorter than this; none
 * can be longer.
 */
export const STATIC_QR_SUNSET_AT = new Date('2026-11-01T00:00:00.000Z');
/** How long a newly grandfathered hub gets to move to the station screen. */
export const STATIC_QR_GRACE_DAYS = 30;
/** Warn the hub owner once they are inside this window of losing static acceptance. */
export const STATIC_QR_WARN_DAYS = 14;

// ─── Phase 6: AI layer v1 (rule-based) (FR-9) ───────────────────────────────────────────────
/**
 * v2 (A-4): the acceptance signal joined the ranking. Bumped because `engine_version` is stamped
 * onto every logged recommendation — leaving it at v1 would make two materially different rankings
 * indistinguishable in the very dataset meant to evaluate them.
 */
export const AI_ENGINE_VERSION = 'rule-v2';
export const AI_RECENT_WINDOW_DAYS = 7; // "this week" sell-through window
export const AI_REC_LIMIT_DEFAULT = 10;
// Rule-based scoring weights (sum ~1). Tuned by hand; replaced by a trained model once data warrants.
export const AI_WEIGHTS = {
  sellThrough: 0.42,
  affinity: 0.18,
  timeOfDay: 0.13,
  proximity: 0.12,
  /** A-4: how often sellers actually acted on this recommendation. */
  acceptance: 0.15,
} as const;

/**
 * A-4 ACCEPTANCE SIGNAL — the guards matter more than the weight.
 *
 * Feeding a ranking its own accepted output is a self-reinforcing loop: whatever ranked first
 * yesterday gets shown most, accumulates the most accepts, and ranks first forever. Three things
 * keep it honest:
 *
 *   1. It is a RATE (accepted/shown), not a count — being shown often earns nothing by itself.
 *   2. Laplace smoothing pulls thin samples toward the prior instead of letting 1-of-1 read as 100%.
 *   3. `MIN_SHOWN` withholds the signal entirely until a product has a real sample, so new stock
 *      competes on its merits rather than being buried for lack of history.
 *
 * The seller's OWN accepts are treated separately and more strongly: personal evidence about what
 * someone can carry and sell beats the crowd's average.
 */
export const AI_ACCEPTANCE_WINDOW_DAYS = 30; // longer than sell-through: accepts are rarer events
export const AI_ACCEPTANCE_MIN_SHOWN = 5; // below this, no population signal at all
export const AI_ACCEPTANCE_SMOOTHING = 3; // Laplace pseudo-counts
export const AI_ACCEPTANCE_PERSONAL_BOOST = 1; // full-strength signal for the seller's own accepts
// UTC hour bands where a category tab sees higher demand (time-of-day heuristic).
export const AI_TIME_BANDS: Record<string, [number, number][]> = {
  coffee: [[6, 11]],
  food: [
    [11, 14],
    [17, 21],
  ],
  services: [[8, 18]],
  shopping: [[10, 20]],
  more: [[9, 21]],
};

// ─── Phase 7: Jobs & Shelter (Flow 9/10, FR-12) ─────────────────────────────────────────────
/**
 * JOB TAXONOMY (A-5). The "Earn Today" brief names six kinds of work; the model had only
 * `pay_unit: flat | hourly`, so none of them could be filtered, matched or ranked — every gig was
 * an untyped title string. Retrofitting a type after a corpus of postings exists means a migration,
 * so it lands now while `sell` is a safe default for everything already written.
 *
 * These are the shapes of work, not job titles: `signage` covers sign-holding and street promotion,
 * `sampling` covers product demos and handouts, `promotion` covers social/flyer distribution.
 */
export const JOB_TYPES = [
  'sell',
  'signage',
  'delivery',
  'sampling',
  'promotion',
  'event_staffing',
] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const JOB_TYPE_LABELS: Record<JobType, string> = {
  sell: 'Selling',
  signage: 'Sign holding',
  delivery: 'Delivery',
  sampling: 'Product sampling',
  promotion: 'Promotion',
  event_staffing: 'Event staffing',
};
/**
 * Default for postings written before the field existed. `sell` is the honest choice: the pilot's
 * gigs were consignment-selling work, so it describes them rather than inventing a category.
 */
export const DEFAULT_JOB_TYPE: JobType = 'sell';

export const JOBS_DEFAULT_RADIUS_M = 8000;
export const JOBS_MAX_RADIUS_M = 40000;
export const JOB_CHECKIN_RADIUS_M = 250; // on-site tap check-in tolerance when coords supplied
/**
 * Grace after a gig's start time before an un-checked-in claim is released as a no-show.
 * 90 minutes: long enough to absorb traffic, a late start, or a worker who forgot to tap in on
 * arrival; short enough that an abandoned shift returns to the board while it can still be filled.
 * Only applies to gigs with a `starts_at` — an open-ended gig has no deadline to be late for.
 */
export const JOB_NO_SHOW_GRACE_MIN = 90;
/**
 * ═══ PHASE D — THE EARN HUB (D-1) ═══
 *
 * The brief's "Earn Today" lists selling, gigs and promotions as one section ranked by the fastest
 * paying opportunity. The app had them on separate screens with no common ranking, so a seller
 * comparing "take stock" against "work a shift" had to do it in their head.
 *
 * Two axes, not one. Expected payout alone would always rank a $90 four-hour gig above $18 of
 * candles, ignoring that the candles pay when they sell and the gig pays after the shift — and
 * someone who needs money for a bed tonight is optimising for the second axis, not the first.
 */
export const EARN_WEIGHTS = {
  payout: 0.55,
  speed: 0.3,
  /** Proximity matters more here than elsewhere: transport eats a street seller's margin. */
  proximity: 0.15,
} as const;
/** Payout that saturates the payout signal — beyond this, more money stops improving the rank. */
export const EARN_PAYOUT_REF_CENTS = 10_000; // $100
/** Hours-to-payout that saturates the speed signal (anything slower scores 0). */
export const EARN_SPEED_REF_HOURS = 72;
export const EARN_PROX_MAX_M = 20_000;
export const EARN_DEFAULT_LIMIT = 20;

/**
 * Honest time-to-payout per opportunity kind, in hours. These are the numbers the ranking trusts,
 * so they must match what actually happens rather than what we'd like to claim:
 *  • `gig`   — paid on check-out, subject to the tier payout hold. Same day.
 *  • `consignment_digital` — split at the moment the customer pays by card.
 *  • `consignment_cash`    — the seller holds the cash immediately, but owes the hub's share.
 * A consignment opportunity is quoted at the digital figure because that is the rail we want chosen,
 * and quoting the cash figure would advertise the rail that creates debt.
 */
export const EARN_HOURS_TO_PAYOUT = {
  gig: 4,
  consignment: 24,
  promotion: 24,
} as const;

/**
 * ═══ PHASE D — SELLER PROFILE (D-2) ═══
 *
 * The vocabulary a seller describes themselves with. Closed lists rather than free text because
 * these are matching INPUTS — the ranking engine has to compare them against product categories,
 * and free text would need parsing that would then be wrong in ways nobody could debug.
 *
 * Kept deliberately short. A long form is a form nobody finishes, and an unfinished profile is
 * worse than a blank one: it looks like data while being unrepresentative.
 */
export const SELLER_SKILLS = [
  'talking_to_people', // the brief's "good at talking with customers"
  'crafts_and_handmade',
  'food_and_drink',
  'tech_and_gadgets',
  'fashion_and_style',
  'kids_and_family',
  'automotive',
  'sports_and_outdoors',
] as const;
export type SellerSkill = (typeof SELLER_SKILLS)[number];

/** Where someone actually sells — the brief's "someone attending car events" signal. */
export const SELLER_VENUES = [
  'street_and_sidewalk',
  'parks',
  'farmers_markets',
  'sports_events',
  'car_events',
  'concerts_and_festivals',
  'transit_hubs',
  'campus',
] as const;
export type SellerVenue = (typeof SELLER_VENUES)[number];

/**
 * How they move stock. This is a real constraint, not a preference: recommending a bulky pickup to
 * someone on foot wastes their trip and the hub's stock.
 */
export const SELLER_TRANSPORT = ['on_foot', 'bike', 'transit', 'car', 'van'] as const;
export type SellerTransport = (typeof SELLER_TRANSPORT)[number];

/**
 * Rough carrying capacity per transport mode, in cents of declared stock value. Used as a SOFT
 * signal in ranking (a heavy pickup ranks lower for someone on foot), never as a hard block — a
 * seller who says they can manage it is a better authority on their own legs than we are.
 */
export const TRANSPORT_CAPACITY_CENTS: Record<SellerTransport, number> = {
  on_foot: 7_500,
  bike: 12_500,
  transit: 15_000,
  car: 50_000,
  van: 150_000,
};

/** Completed checkouts after which inferred signals outweigh self-declared ones. */
export const SELLER_INFERENCE_CONFIDENCE_SALES = 8;

export const SHELTER_COSIGN_TIER = 'bronze'; // resident enters at Tier-1-equivalent (Flow 1b)
export const SHELTER_ACTIVE_WINDOW_DAYS = 30; // "30-day active earning streak" outcome proxy

/**
 * ═══ PHASE B — RESIDENT CAPABILITY MATRIX (B-2) ═══
 *
 * A shelter-cosigned resident is verified by a DIFFERENT kind of evidence than everyone else. There
 * is no government ID and no bank account behind them — there is a named staff member at a verified
 * partner org who vouched for them in person, and a capped sum that org agreed to stand behind.
 *
 * That difference has to show up as capabilities, not just as a tier label. The cosign already
 * grants Bronze (`VERIFICATION_TYPE_TIER.shelter_cosign`), and Bronze's ordinary $200 ceiling was
 * being applied wholesale — which meant `cosigned_allocation_cents`, documented in the schema as
 * "the HARD cap on the shelter's liability (FR-12.4)", capped nothing at all. A shelter that
 * cosigned $50 was silently exposed to $200.
 *
 * So the effective ceiling for a resident is the MINIMUM of:
 *   • their tier/Trust ceiling (the ordinary rules, which still apply), and
 *   • the shelter's remaining cosigned allocation (this org's stated exposure), and
 *   • `RESIDENT_MAX_INVENTORY_VALUE_CENTS` (a platform-wide backstop, so a generous cosign can't
 *     hand someone with no identity file an unbounded amount of someone else's stock).
 *
 * None of this is about distrusting residents. It is about making the shelter's liability real and
 * bounded, because a program that quietly exceeds what a partner agreed to is a program partners
 * stop joining.
 */
export const RESIDENT_MAX_INVENTORY_VALUE_CENTS = 15_000; // $150 platform backstop
/**
 * Residents settle in cash far more often than other sellers (no bank account, street sales), and
 * cash debt is the one exposure the platform cannot recover. Kept deliberately tight and separate
 * from the tier default.
 */
export const RESIDENT_MAX_CASH_DEBT_CENTS = 5_000; // $50
/**
 * Stock must be collected from a hub near the shelter. This is a practical constraint, not a
 * restrictive one: a resident travelling far to reach inventory is a resident who spends their
 * earnings on transport, and the shelter can't help resolve a problem at a hub across the county.
 * Null shelter coordinates disable the check rather than blocking enrollment.
 */
export const RESIDENT_MAX_HUB_DISTANCE_M = 25_000; // ~15 miles

/**
 * B-5 training gate. A resident must complete the starter curriculum before taking stock — not as a
 * hurdle, but because handing someone consigned goods without telling them the return window, the
 * cash rules and what they owe is how a well-meaning program creates its first debt spiral.
 * Deliberately short: four modules, completable in one sitting on a borrowed phone.
 */
export const RESIDENT_REQUIRED_TRAINING_SLUG = 'resident-starter';
/** Passing score on the module quiz, as a percentage. Low bar — comprehension, not an exam. */
export const TRAINING_PASS_PERCENT = 70;

/**
 * B-4 starter grants. The first checkout carries ZERO risk to the resident: if it doesn't sell, the
 * shelter's cosign absorbs it and no debt is written against the person. This is the "begin earning
 * same day" promise made real — a resident with nothing cannot be asked to accept downside on their
 * first day, because the downside is the exact thing that put them here.
 */
export const RESIDENT_STARTER_GRANT_MAX_CENTS = 5_000; // $50 of stock
export const RESIDENT_STARTER_GRANT_LIMIT = 1; // one per resident, per shelter

/**
 * Free AI advice per user per calendar month, before the AI Marketing Assistant plan is required.
 *
 * The plan sold "unlimited AI coaching, pricing and marketing copy" for $19.99/month while nothing
 * read the entitlement — every AI route was open to everyone, so a subscriber paid for exactly what
 * a non-subscriber already had. This is the number that makes the plan mean something.
 *
 * Five, not one and not thirty. One answer is not enough to judge whether the advice is any good,
 * so a single free call sells nothing. Thirty (one a day) covers ordinary use and no one ever
 * reaches a decision. Five lets a seller run the Income Coach, price something and pull
 * recommendations — a real taste — while anyone using it seriously runs out within the month.
 *
 * Per CALENDAR month rather than a rolling window: it resets on the same cadence the subscription
 * bills on, so "you have used your 5 free this month" and "the plan is unlimited" describe the same
 * period. A rolling 30-day window would drip allowances back one at a time and never produce that
 * moment.
 */
export const AI_FREE_REQUESTS_PER_MONTH = 5;

/**
 * ═══ SPONSORSHIP TIERS (self-serve) ═══
 *
 * Priced in code rather than the fee registry: the registry prices a RATE applied to somebody
 * else's transaction, whereas this is a product with a list price, and folding it in would let a
 * fee-schedule edit silently change what a sponsor is charged mid-term.
 *
 * A sponsor picks a tier and a term; the price is `monthly_cents × months`. The server re-derives
 * it from this table on every purchase — a client that could name its own price could sponsor the
 * platform for a cent.
 */
export const SPONSOR_TIERS = [
  {
    slug: 'community',
    name: 'Community',
    monthlyCents: 9_900,
    blurb: 'Your logo on the StreetServe landing page, and a link that tracks every signup it sends us.',
  },
  {
    slug: 'launch',
    name: 'Launch partner',
    monthlyCents: 29_900,
    blurb: 'Everything in Community, with larger placement and a named launch-partner lockup.',
  },
  {
    slug: 'founding',
    name: 'Founding partner',
    monthlyCents: 99_900,
    blurb: 'Top placement, named as a founding partner, and a monthly report on reach and signups.',
  },
] as const;

export type SponsorTierSlug = (typeof SPONSOR_TIERS)[number]['slug'];

/** The terms a sponsor may buy. Longer terms exist so a sponsor is not re-billed every month. */
export const SPONSOR_TERM_MONTHS = [1, 3, 6, 12] as const;
