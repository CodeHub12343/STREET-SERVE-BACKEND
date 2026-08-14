/**
 * ═══ PRINT / DIRECT-MAIL VENDOR — domain-shaped boundary ═══
 *
 * Contracted vendor: PostcardMania ("PCM Integrations"), DirectMail API v3. Nothing in this file
 * names them. THIRD_PARTY_INTEGRATIONS.md §1 requires every third party behind an internal
 * interface, and the audit rated the unsigned partnership HIGH technical debt (TD-9).
 *
 * ## Money: the vendor is a SUPPLIER, not a payee (ADR-007 §4, Topology B)
 *
 * StreetServe buys at wholesale and resells at retail. Every amount here is the WHOLESALE COST TO
 * US, never a customer-facing price. Margin is applied above this layer and is deliberately
 * invisible to the adapter. Confirmed by the vendor's own billing model: they run a prepaid
 * retainer (`getBalance`), which is a supplier relationship, not a marketplace split.
 *
 * All amounts are integer cents.
 *
 * ## Shape driven by the vendor's real model, now that the spec is in hand
 *
 * The vendor does NOT do ad-hoc quotes or push status webhooks. What it actually offers:
 *   1. Create a LIST COUNT for an area (zip / carrier route / radius) → count + an id
 *   2. Price it yourself from the design's published price breaks
 *   3. Place an order against that list-count id
 *   4. POLL for status
 * This interface mirrors that, rather than pretending a quote endpoint exists.
 */

/**
 * The fulfilment pipeline, shared with Boost (`boost.model.ts`).
 *
 * `delivered` remains absent, but the reason has changed and is worth recording. The rule was
 * "only add it if a vendor is proven to report it" — and this vendor DOES report `Delivered`.
 * Its own definition, though, is *"scanned by the last postal facility and will start hitting
 * mailboxes"* — which is not delivery to a mailbox. Showing a buyer "delivered" on that basis
 * would overclaim, so it maps to `mailed` and adding a distinct arriving-soon state is left as a
 * product decision (see PCM_DISCOVERY_FINDINGS.md).
 */
export const FULFILMENT_STATUSES = ['preparing', 'printing', 'mailed'] as const;
export type FulfilmentPipelineStatus = (typeof FULFILMENT_STATUSES)[number];

/**
 * Terminal states. Absent from the original design, and their absence was a real gap: the vendor
 * can end an order in ways that are not "further along the pipeline", and a status mapper with
 * nowhere to put them would either throw on a legitimate value or silently mislead.
 *
 * `payment_hold` is the one to watch under Topology B — the vendor runs a prepaid retainer, so an
 * order can stall purely because our account balance ran out. That is an ops alert, not a
 * customer-facing failure.
 */
export const TERMINAL_STATUSES = [
  'canceled',
  'undeliverable',
  'failed',
  'payment_hold',
] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export type FulfilmentStatus = FulfilmentPipelineStatus | TerminalStatus;

export const isTerminal = (s: FulfilmentStatus): s is TerminalStatus =>
  (TERMINAL_STATUSES as readonly string[]).includes(s);

// ─── Audience (the vendor calls it a "list count") ──────────────────────────────────────────

/** How a buyer picked the area. The vendor supports exactly these three. */
export type AudienceSelectionType = 'zip' | 'carrier_route' | 'radius';

export interface AudienceRequest {
  type: AudienceSelectionType;
  /** ZIP codes, or carrier routes in the vendor's `ZIP:ROUTE` form (e.g. `95350:C002`). */
  keys?: string[];
  /** Only for `radius`. */
  radius?: { miles: number; address: string; city: string; state: string; zip: string };
  /** Vendor list type key from `listTypes()` (e.g. resident/occupant). */
  listType: string;
}

export interface AudienceBreakdownRow {
  code: string;
  label: string;
  total: number;
}

/**
 * A priced, orderable audience.
 *
 * **The privacy-critical property: this is an ID and a COUNT, not addresses.** The vendor resolves,
 * holds, and mails the list; StreetServe never receives consumer names or home addresses. This is
 * exactly the mitigation `ARCHITECTURAL_IMPROVEMENTS.md` §6 hoped for, and the integration should
 * be kept this way deliberately — the alternative shape (us supplying recipients) exists on the
 * vendor's API and would drag consumer PII into our systems for no product gain.
 */
export interface AudienceCount {
  /** Vendor-opaque. Passed back verbatim when ordering; never parsed. */
  listCountId: string;
  /** Deliverable addresses, per the VENDOR — never computed by us (audit F-9). */
  recordCount: number;
  breakdown: AudienceBreakdownRow[];
}

export interface ListType {
  key: string;
  label: string;
}

// ─── Pricing ────────────────────────────────────────────────────────────────────────────────

export type MailClass = 'first_class' | 'standard';

/** One published volume break: this price per piece once you order at least `minQuantity`. */
export interface PriceBreak {
  mailClass: MailClass;
  unitCostCents: number;
  minQuantity: number;
}

/**
 * A priced run.
 *
 * **`isBinding` is always false today, and that is a fact about the vendor, not a TODO.** They
 * publish price breaks per design; they do not expose a quote endpoint that reserves a price. So
 * this is computed by us from their published table, and the authoritative charge lands on the
 * invoice. Callers must treat it as an estimate and re-price at checkout (audit F-8).
 */
export interface RunPrice {
  quantity: number;
  mailClass: MailClass;
  unitCostCents: number;
  /** WHOLESALE cost to StreetServe for the whole run. Not the customer's price. */
  vendorCostCents: number;
  isBinding: false;
  appliedBreak: PriceBreak;
}

// ─── Orders ─────────────────────────────────────────────────────────────────────────────────

export interface SubmitOrderRequest {
  /** Vendor size key for the product (postcard sizes only, for MVP). */
  sizeKey: string;
  mailClass: MailClass;
  listCountId: string;
  recordCount: number;
  /**
   * Print-ready artwork URLs. **Both sides are required by the vendor** even though the buyer only
   * designs the front — a mailed postcard must carry an address side. This settles the "one side"
   * question from the spec: one DESIGNED side, two printed sides.
   */
  artwork: { frontUrl: string; backUrl: string };
  /**
   * Our order id, sent as the vendor's `extRefNbr`.
   *
   * **This is the idempotency mechanism**, and it is the vendor's own: a duplicate reference is
   * rejected with 409 rather than producing a second print run. It resolves audit F-6 — retrying a
   * submission is safe, because the worst case is a 409 we can interpret, not paper in mailboxes.
   */
  orderRef: string;
  /** Batches process at end of day; the order joins the batch for this date. */
  mailDate: Date;
  /** USPS recommends one for First Class; deliverability is not guaranteed without it. */
  returnAddress: PostalAddress;
}

export interface PostalAddress {
  company?: string;
  firstName?: string;
  lastName?: string;
  address: string;
  address2?: string;
  city: string;
  state: string;
  zipCode: string;
}

export interface VendorOrderRef {
  vendorOrderId: string;
  vendorBatchId: string;
  orderRef: string;
  /** True when the vendor rejected this reference as already seen — i.e. our retry was absorbed. */
  deduplicated: boolean;
}

export interface AccountBalance {
  /** Prepaid retainer held with the vendor, in cents. */
  moneyOnAccountCents: number;
}

/**
 * Every method rejects with an `AppError`. Transport, auth, token refresh, retry, and error
 * translation are the gateway's job; callers never see a vendor status code.
 *
 * Note the absence of `parseWebhook`: **the vendor pushes no status callbacks.** Their only
 * webhook route is inbound (a way to place orders *at* them). Status must be polled, which the
 * fulfilment sweep does — designing around a webhook that does not exist would have produced a
 * pipeline that silently never advances.
 */
export interface PrintVendorGateway {
  /** Available recipient list types (vendor-defined). */
  listTypes(): Promise<ListType[]>;

  /** Resolve an area to an orderable, counted audience. The vendor keeps the addresses. */
  createAudienceCount(input: AudienceRequest): Promise<AudienceCount>;

  /** Published price breaks for a product size. */
  priceBreaks(sizeKey: string): Promise<PriceBreak[]>;

  /** Compute a run price from published breaks. Never binding — see `RunPrice`. */
  priceRun(input: { sizeKey: string; mailClass: MailClass; quantity: number }): Promise<RunPrice>;

  /**
   * Hands the job to the vendor.
   *
   * NOT an immediate point of no return: the vendor batches at end of day and accepts
   * cancellation until their daily cutoff. `cancelOrder` is real until then — see ADR-007 §2,
   * which this discovery improves rather than contradicts.
   */
  submitOrder(input: SubmitOrderRequest): Promise<VendorOrderRef>;

  /** Poll. There is no push. */
  getStatus(vendorOrderId: string): Promise<FulfilmentStatus>;

  /** Succeeds only before the vendor's daily batch cutoff; rejects afterwards. */
  cancelOrder(vendorOrderId: string): Promise<void>;

  /**
   * Prepaid retainer balance. Under Topology B an order can stall purely because our account ran
   * dry, so this is checked before submitting rather than discovered as a stuck order.
   */
  getBalance(): Promise<AccountBalance>;
}
