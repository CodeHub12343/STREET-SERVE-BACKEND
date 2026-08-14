import {
  HubModel,
  InventoryCheckoutModel,
  InventoryReturnModel,
  InventorySaleModel,
  ProductModel,
  SettlementModel,
} from './consignment.model';

export const consignmentRepository = {
  // ─── Hubs ─────────────────────────────────────────────────────────────────────────────────
  createHub(data: {
    business_id: string;
    owner_user_id: string;
    checkout_qr_secret: string;
    address?: string | null;
    city_slug?: string | null;
  }) {
    return HubModel.create(data);
  },
  findHubByBusiness(businessId: string) {
    return HubModel.findOne({ business_id: businessId }).exec();
  },
  findHubById(id: string) {
    return HubModel.findById(id).exec();
  },
  updateHubApprovalPolicy(
    hubId: string,
    patch: {
      auto_approve_min_trust?: number;
      auto_approve_max_value_cents?: number | null;
      city_slug?: string | null;
    },
  ) {
    return HubModel.findByIdAndUpdate(hubId, { $set: patch }, { new: true }).exec();
  },
  listHubsByOwner(userId: string) {
    return HubModel.find({ owner_user_id: userId }).sort({ created_at: -1 }).lean().exec();
  },

  // ─── Products ─────────────────────────────────────────────────────────────────────────────
  createProduct(data: {
    hub_id: string;
    name: string;
    unit_value_cents: number;
    consignment_split_percent: number;
    return_window_hours: number;
    listing_type: string;
    quantity_available: number;
    photos?: string[];
    category?: string | null;
    condition_requirements?: string | null;
    category_id?: string | null;
    term_days?: number | null;
    minimum_authorized_price_cents?: number | null;
    seller_permissions?: {
      may_discount: boolean;
      may_bundle: boolean;
      may_accept_offers: boolean;
      may_sell_below_min: boolean;
    };
    return_responsibility?: 'seller' | 'hub';
    return_window_days?: number;
    storage_fee_cents_per_day?: number;
    abandonment_after_days?: number;
    /** §37 notice period; null = derive from declared value at checkout. */
    termination_notice_days?: number | null;
    /** §39 renewal, opt-in per product. */
    auto_renew?: boolean;
    auto_renew_term?: number | string | null;
    min_seller_trust_score?: number | null;
    required_certification?: string | null;
  }) {
    return ProductModel.create(data);
  },
  findProductById(id: string) {
    return ProductModel.findById(id).exec();
  },
  listProductsByHub(hubId: string) {
    return ProductModel.find({ hub_id: hubId, quantity_available: { $gt: 0 } })
      .sort({ created_at: -1 })
      .lean()
      .exec();
  },
  /** All products for a hub regardless of stock (dashboard needs sold-out fast movers too). */
  allProductsByHub(hubId: string) {
    return ProductModel.find({ hub_id: hubId }).sort({ created_at: -1 }).lean().exec();
  },
  /** Atomically reserve `qty` units (guards against reserving more than available). */
  reserveProduct(productId: string, qty: number) {
    return ProductModel.findOneAndUpdate(
      { _id: productId, quantity_available: { $gte: qty } },
      { $inc: { quantity_available: -qty } },
      { new: true },
    ).exec();
  },
  /**
   * 7.2 — returns the product AFTER the increment, and the repository reports whether stock crossed
   * zero. Doing that here rather than at the two call sites keeps "was it out of stock?" attached
   * to the write that changed it; a caller reading the count separately would race another return.
   */
  async restockProduct(productId: string, qty: number) {
    const before = await ProductModel.findById(productId).select('quantity_available name').lean();
    const updated = await ProductModel.findByIdAndUpdate(
      productId,
      { $inc: { quantity_available: qty } },
      { new: true },
    ).exec();
    return {
      product: updated,
      cameBackInStock: (before?.quantity_available ?? 0) === 0 && qty > 0,
      name: updated?.name ?? before?.name ?? 'An item',
    };
  },

  // ─── Seller agreement acceptance MOVED to modules/agreements (R28, generalized + tamper-evident).

  // ─── Checkouts ────────────────────────────────────────────────────────────────────────────
  createCheckout(data: {
    seller_id: string;
    product_id: string;
    hub_id: string;
    quantity: number;
    unit_value_cents: number;
    consignment_split_percent: number;
    condition_photo_url: string;
    seller_agreement_version: string;
    expected_return_at: Date;
    term_days: number | null;
    expires_at: Date | null;
    current_unit_price_cents: number;
    minimum_authorized_price_cents: number | null;
    seller_permissions: {
      may_discount: boolean;
      may_bundle: boolean;
      may_accept_offers: boolean;
      may_sell_below_min: boolean;
    };
    return_responsibility: 'seller' | 'hub';
    return_window_days: number;
    storage_fee_cents_per_day: number;
    abandonment_after_days: number;
    /** §37/§39 terms snapshotted at pickup, like every other term on this row. */
    termination_notice_days?: number | null;
    auto_renew?: boolean;
    auto_renew_term?: number | string | null;
    // A-3: Trust band snapshotted at pickup — settlement reads these, never a live score.
    trust_score_at_checkout?: number | null;
    trust_band?: string | null;
    trust_fee_discount_bps?: number;
    seller_plus_at_checkout?: boolean;
    status?: string;
    approved_at?: Date | null;
    approved_by?: string | null;
  }) {
    return InventoryCheckoutModel.create(data);
  },
  /** B-4: mark a checkout as covered by a shelter's starter grant. */
  markStarterGrant(checkoutId: string, partnerId: string) {
    return InventoryCheckoutModel.updateOne(
      { _id: checkoutId },
      { $set: { starter_grant_partner_id: partnerId } },
    ).exec();
  },
  findCheckoutById(id: string) {
    return InventoryCheckoutModel.findById(id).exec();
  },

  // ─── Consignment lifecycle (R14/R15/R17/R18) ────────────────────────────────────────────────
  /** Active checkouts with a real expiry inside the notice window (14 days out), for the sweep. */
  dueForExpiryNotice(now: Date, limit: number) {
    const horizon = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    return InventoryCheckoutModel.find({
      status: { $in: ['active', 'overdue'] },
      expires_at: { $ne: null, $lte: horizon },
    })
      .limit(limit)
      .exec();
  },
  recordNoticesSent(checkoutId: string, thresholds: number[]) {
    return InventoryCheckoutModel.updateOne(
      { _id: checkoutId },
      { $addToSet: { notices_sent: { $each: thresholds } } },
    ).exec();
  },
  /** Move an unsold-at-expiry checkout into Return-Pending (never auto-keep). */
  moveToReturnPending(checkoutId: string) {
    return InventoryCheckoutModel.findOneAndUpdate(
      { _id: checkoutId, status: { $in: ['active', 'overdue'] } },
      { $set: { status: 'return_pending', return_pending_at: new Date() } },
      { new: true },
    ).exec();
  },
  extendCheckout(checkoutId: string, from: string[], expiresAt: Date | null, termDays: number | null) {
    return InventoryCheckoutModel.findOneAndUpdate(
      { _id: checkoutId, status: { $in: from } },
      {
        $set: {
          expires_at: expiresAt,
          term_days: termDays,
          notices_sent: [],
          // A fresh term gets a fresh renewal notice; otherwise the last term's would suppress it.
          renewal_notice_sent_for: null,
        },
      },
      { new: true },
    ).exec();
  },

  /**
   * §37 — schedule the end rather than performing it. Only an ACTIVE consignment with no notice
   * already running can be served: two notices would mean two effective dates for one agreement.
   */
  giveTerminationNotice(
    checkoutId: string,
    input: { endedBy: 'seller' | 'hub'; noticeDays: number; noticeAt: Date; effectiveAt: Date },
  ) {
    return InventoryCheckoutModel.findOneAndUpdate(
      { _id: checkoutId, status: { $in: ['active', 'overdue'] }, termination_notice_at: null },
      {
        $set: {
          terminated_by: input.endedBy,
          termination_notice_days: input.noticeDays,
          termination_notice_at: input.noticeAt,
          termination_effective_at: input.effectiveAt,
          // Notice cancels any pending renewal — renewing a term you are ending is nonsense.
          auto_renew: false,
          auto_renew_term: null,
        },
      },
      { new: true },
    ).exec();
  },
  /** Notices whose period has elapsed — the sweep moves these to Return-Pending. */
  dueForTermination(now: Date, limit: number) {
    return InventoryCheckoutModel.find({
      status: { $in: ['active', 'overdue'] },
      termination_effective_at: { $ne: null, $lte: now },
    })
      .limit(limit)
      .lean()
      .exec();
  },

  setAutoRenew(
    checkoutId: string,
    input: { enabled: boolean; term: number | string | null; cancelledBy: 'seller' | 'hub' | null },
  ) {
    return InventoryCheckoutModel.findOneAndUpdate(
      // Never on a consignment already ending: turning renewal back on mid-notice would fight the
      // termination the parties just agreed to.
      { _id: checkoutId, status: { $in: ['active', 'overdue'] }, termination_notice_at: null },
      {
        $set: {
          auto_renew: input.enabled,
          auto_renew_term: input.term,
          auto_renew_cancelled_by: input.cancelledBy,
        },
      },
      { new: true },
    ).exec();
  },

  /** §39 — renew in place: push the expiry out, re-arm notices, and count it. */
  renewCheckout(checkoutId: string, expiresAt: Date, termDays: number | null) {
    return InventoryCheckoutModel.findOneAndUpdate(
      { _id: checkoutId, auto_renew: true, status: { $in: ['active', 'overdue'] } },
      {
        $set: {
          expires_at: expiresAt,
          term_days: termDays,
          notices_sent: [],
          renewal_notice_sent_for: null,
        },
        $inc: { renewal_count: 1 },
      },
      { new: true },
    ).exec();
  },
  /** Record that the pre-renewal notice fired for this term, so it fires exactly once. */
  markRenewalNoticed(checkoutId: string, expiresAt: Date) {
    return InventoryCheckoutModel.updateOne(
      { _id: checkoutId },
      { $set: { renewal_notice_sent_for: expiresAt } },
    ).exec();
  },

  /** §36 — the split going forward. Guarded in the service against already-sold units. */
  setSplitPercent(checkoutId: string, splitPercent: number) {
    return InventoryCheckoutModel.findOneAndUpdate(
      { _id: checkoutId, status: { $in: ['active', 'overdue'] }, quantity_sold: 0 },
      { $set: { consignment_split_percent: splitPercent } },
      { new: true },
    ).exec();
  },
  setCurrentPrice(checkoutId: string, from: string[], priceCents: number) {
    return InventoryCheckoutModel.findOneAndUpdate(
      { _id: checkoutId, status: { $in: from } },
      { $set: { current_unit_price_cents: priceCents } },
      { new: true },
    ).exec();
  },
  /** Return-Pending checkouts past their abandonment cutoff — flagged for lawful review, never kept. */
  dueForAbandonmentReview(now: Date, limit: number) {
    return InventoryCheckoutModel.find({
      status: 'return_pending',
      return_pending_at: { $ne: null },
    })
      .limit(limit)
      .exec()
      .then((rows) =>
        rows.filter(
          (c) =>
            c.return_pending_at != null &&
            now.getTime() - c.return_pending_at.getTime() >=
              (c.abandonment_after_days ?? 30) * 24 * 60 * 60 * 1000,
        ),
      );
  },
  /**
   * Approve a pending reservation — conditional on it still being pending, so two hub staff
   * clicking Approve can't both win (and an approve can't race a decline).
   */
  approveCheckout(checkoutId: string, approvedBy: string) {
    return InventoryCheckoutModel.findOneAndUpdate(
      { _id: checkoutId, status: 'pending_approval' },
      { $set: { status: 'active', approved_at: new Date(), approved_by: approvedBy } },
      { new: true },
    ).exec();
  },
  declineCheckout(checkoutId: string, reason: string | null) {
    return InventoryCheckoutModel.findOneAndUpdate(
      { _id: checkoutId, status: 'pending_approval' },
      { $set: { status: 'declined', declined_at: new Date(), decline_reason: reason } },
      { new: true },
    ).exec();
  },
  listCheckoutsByHub(hubId: string, statuses?: string[]) {
    return InventoryCheckoutModel.find({
      hub_id: hubId,
      ...(statuses ? { status: { $in: statuses } } : {}),
    })
      .sort({ created_at: -1 })
      .limit(200)
      .lean()
      .exec();
  },
  settlementsByCheckoutIds(ids: string[]) {
    return SettlementModel.find({ checkout_id: { $in: ids } })
      .sort({ settled_at: -1 })
      .lean()
      .exec();
  },
  async sumReturns(checkoutId: string): Promise<number> {
    const rows = await InventoryReturnModel.aggregate<{ _id: null; returned: number }>([
      { $match: { checkout_id: checkoutId } },
      { $group: { _id: null, returned: { $sum: '$quantity_returned' } } },
    ]).exec();
    return rows[0]?.returned ?? 0;
  },
  /** Declared value of stock the seller is holding right now (credit-limit exposure). */
  async sumActiveInventoryValue(sellerId: string): Promise<number> {
    const rows = await InventoryCheckoutModel.aggregate<{ _id: null; total: number }>([
      {
        $match: {
          seller_id: sellerId,
          status: { $in: ['pending_approval', 'active', 'overdue', 'return_pending'] },
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $multiply: [
                { $ifNull: ['$unit_value_cents', 0] },
                { $subtract: ['$quantity', { $ifNull: ['$quantity_sold', 0] }] },
              ],
            },
          },
        },
      },
    ]).exec();
    return rows[0]?.total ?? 0;
  },
  listCheckoutsBySeller(sellerId: string, limit: number) {
    return InventoryCheckoutModel.find({ seller_id: sellerId })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
  },
  /**
   * THE oversell guard (FR-8.3): apply a sale only if quantity_sold + qty ≤ quantity, atomically.
   * Returns the updated doc, or null if it would oversell (or the checkout is not active).
   */
  applySaleGuarded(checkoutId: string, qty: number) {
    return InventoryCheckoutModel.findOneAndUpdate(
      {
        _id: checkoutId,
        status: 'active',
        $expr: { $lte: [{ $add: ['$quantity_sold', qty] }, '$quantity'] },
      },
      { $inc: { quantity_sold: qty } },
      { new: true },
    ).exec();
  },
  /**
   * Hold units for a pending digital payment. Same atomic oversell guard as a cash sale — the units
   * must be committed BEFORE the customer pays, or two customers could buy the same last item.
   */
  reserveSaleUnits(checkoutId: string, qty: number) {
    return this.applySaleGuarded(checkoutId, qty);
  },
  /** Release units held by a payment that failed, expired, or was cancelled. Never below zero. */
  releaseSaleUnits(checkoutId: string, qty: number) {
    return InventoryCheckoutModel.findOneAndUpdate(
      { _id: checkoutId, quantity_sold: { $gte: qty } },
      { $inc: { quantity_sold: -qty } },
      { new: true },
    ).exec();
  },
  setCheckoutStatus(checkoutId: string, from: string, status: string) {
    return InventoryCheckoutModel.findOneAndUpdate(
      { _id: checkoutId, status: from },
      { $set: { status } },
      { new: true },
    ).exec();
  },
  dueOverdue(cutoff: Date, limit: number) {
    return InventoryCheckoutModel.find({ status: 'active', expected_return_at: { $lt: cutoff } })
      .limit(limit)
      .exec();
  },

  // ─── Sales / returns / settlements ──────────────────────────────────────────────────────────
  createSale(data: {
    checkout_id: string;
    quantity_sold: number;
    sale_amount_cents: number;
    proof_photo_url?: string | null;
    logged_via: string;
    payment_rail?: 'cash' | 'digital';
  }) {
    return InventorySaleModel.create(data);
  },
  salesForCheckout(checkoutId: string) {
    return InventorySaleModel.find({ checkout_id: checkoutId }).lean().exec();
  },
  sumSales(checkoutId: string) {
    return InventorySaleModel.aggregate<{ _id: null; gross: number }>([
      { $match: { checkout_id: checkoutId } },
      { $group: { _id: null, gross: { $sum: '$sale_amount_cents' } } },
    ]).exec();
  },
  /**
   * Gross per payment rail. Settlement must charge the SAME fee the sale actually charged — the
   * digital rail is 8% and cash 10%, so a flat rate would make the settlement record disagree with
   * the money that really moved (and misreport the hub's share).
   */
  sumSalesByRail(checkoutId: string) {
    return InventorySaleModel.aggregate<{ _id: string | null; gross: number }>([
      { $match: { checkout_id: checkoutId } },
      { $group: { _id: '$payment_rail', gross: { $sum: '$sale_amount_cents' } } },
    ]).exec();
  },
  /**
   * Proceeds the platform actually holds for this checkout — digital-rail sales only. Cash went
   * straight to the seller and never entered the platform balance, so it can never fund a payout.
   */
  async sumCollectedSales(checkoutId: string): Promise<number> {
    const rows = await InventorySaleModel.aggregate<{ _id: null; collected: number }>([
      { $match: { checkout_id: checkoutId, payment_rail: 'digital' } },
      { $group: { _id: null, collected: { $sum: '$sale_amount_cents' } } },
    ]).exec();
    return rows[0]?.collected ?? 0;
  },
  /** Settlements whose payout legs never completed — the retry job's work queue. */
  findUnpaidSettlements(limit = 50) {
    return SettlementModel.find({
      funding_source: 'collected',
      $or: [{ seller_payout_status: 'no_account' }, { hub_payout_status: 'no_account' }],
    })
      .limit(limit)
      .lean()
      .exec();
  },
  createReturn(data: {
    checkout_id: string;
    quantity_returned: number;
    condition_photo_url?: string | null;
    condition_assessment: string;
  }) {
    return InventoryReturnModel.create(data);
  },
  /**
   * Record that a payout leg finally went out (used by the retry sweep). Settlement figures are
   * immutable, but payout STATUS is a lifecycle fact: without writing it back, a retried transfer
   * left the settlement reading `no_account` forever — understating what the hub had been paid and
   * making the sweep re-examine the same row on every run.
   */
  markSettlementLegPaid(checkoutId: string, leg: 'seller' | 'hub', transferId: string) {
    return SettlementModel.updateOne(
      { checkout_id: checkoutId },
      {
        $set: {
          [`${leg}_payout_status`]: 'paid',
          [`${leg}_payout_ref`]: transferId,
        },
      },
    ).exec();
  },
  createSettlement(data: {
    checkout_id: string;
    gross_sales_cents: number;
    platform_fee_cents: number;
    hub_share_cents: number;
    seller_net_cents: number;
    seller_payout_ref: string | null;
    hub_payout_ref: string | null;
    funding_source: 'collected' | 'unfunded' | 'mixed' | 'none' | 'legacy_unfunded';
    collected_cents: number;
    // A-3: what the Trust discount cost the platform and which band earned it, kept for audit.
    trust_fee_discount_cents?: number;
    trust_band?: string | null;
    seller_payout_status: 'paid' | 'awaiting_funds' | 'no_account' | 'not_applicable';
    hub_payout_status: 'paid' | 'awaiting_funds' | 'no_account' | 'not_applicable';
  }) {
    return SettlementModel.create(data);
  },
  findSettlementByCheckout(checkoutId: string) {
    return SettlementModel.findOne({ checkout_id: checkoutId }).lean().exec();
  },

  // ─── Discovery (seller-side browse, S-01) ──────────────────────────────────────────────────
  /**
   * Available inventory, optionally restricted to hubs near a point (Phase 6).
   * Cursor-paginated on `created_at` — the previous hard cap of 200 silently truncated the catalog
   * once real inventory arrived, and "nearby" was not actually filtered by distance at all.
   */
  async listAvailableProducts(opts: {
    category?: string;
    hubIds?: string[];
    before?: Date;
    limit: number;
  }) {
    return ProductModel.find({
      quantity_available: { $gt: 0 },
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.hubIds ? { hub_id: { $in: opts.hubIds } } : {}),
      ...(opts.before ? { created_at: { $lt: opts.before } } : {}),
    })
      .sort({ created_at: -1, _id: -1 })
      .limit(opts.limit)
      .lean()
      .exec();
  },

  /** Hubs within `radiusM` of a point, nearest first — backed by the 2dsphere index. */
  async hubIdsNear(lng: number, lat: number, radiusM: number, limit = 200): Promise<string[]> {
    const hubs = await HubModel.find({
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [lng, lat] },
          $maxDistance: radiusM,
        },
      },
    })
      .select({ _id: 1 })
      .limit(limit)
      .lean()
      .exec();
    return hubs.map((h) => String(h._id));
  },
  hubsByIds(ids: string[]) {
    return HubModel.find({ _id: { $in: ids } })
      .lean()
      .exec();
  },
  /** Units currently out with sellers (unsold, non-ended checkouts), keyed by product id. */
  async outQuantityByProduct(hubId: string): Promise<Map<string, number>> {
    const rows = await InventoryCheckoutModel.aggregate<{ _id: string; out: number }>([
      { $match: { hub_id: hubId, status: { $in: ['active', 'return_pending', 'overdue'] } } },
      { $group: { _id: '$product_id', out: { $sum: { $subtract: ['$quantity', '$quantity_sold'] } } } },
    ]).exec();
    return new Map(rows.map((r) => [String(r._id), r.out]));
  },

  // ─── Analytics (read by the AI/recommendation engine + hub dashboard) ──────────────────────
  availableProducts(limit: number) {
    return ProductModel.find({ quantity_available: { $gt: 0 } })
      .limit(limit)
      .lean()
      .exec();
  },
  productsByIds(ids: string[]) {
    return ProductModel.find({ _id: { $in: ids } })
      .lean()
      .exec();
  },
  /** D-2: every checkout id for one seller — the denominator for their sell-through. */
  async sellerCheckoutIds(sellerId: string): Promise<string[]> {
    const rows = await InventoryCheckoutModel.find({ seller_id: sellerId }, { _id: 1 })
      .lean()
      .exec();
    return rows.map((r) => String(r._id));
  },
  /**
   * D-2: one seller's sales, joined to the product they came from. Scoped to checkout ids the
   * caller already resolved, so this can never read across sellers.
   */
  async salesForCheckouts(
    checkoutIds: string[],
  ): Promise<Array<{ quantity_sold: number; sold_at: Date; product_id: string | null }>> {
    if (checkoutIds.length === 0) return [];
    const checkouts = await InventoryCheckoutModel.find(
      { _id: { $in: checkoutIds } },
      { product_id: 1 },
    )
      .lean()
      .exec();
    const productByCheckout = new Map(checkouts.map((c) => [String(c._id), c.product_id]));
    const sales = await InventorySaleModel.find(
      { checkout_id: { $in: checkoutIds } },
      { quantity_sold: 1, sold_at: 1, checkout_id: 1 },
    )
      .lean()
      .exec();
    return sales.map((s) => ({
      quantity_sold: s.quantity_sold,
      sold_at: s.sold_at,
      product_id: productByCheckout.get(String(s.checkout_id)) ?? null,
    }));
  },
  /** Distinct product ids a seller has previously checked out (category-affinity signal). */
  async sellerProductIds(sellerId: string): Promise<string[]> {
    const rows = await InventoryCheckoutModel.find({ seller_id: sellerId })
      .distinct('product_id')
      .exec();
    return rows.map((r) => String(r));
  },
  /** Units + revenue sold per product since a date (sell-through signal). */
  recentProductSales(since: Date) {
    return InventorySaleModel.aggregate<{ _id: string; units: number; revenueCents: number }>([
      { $match: { sold_at: { $gte: since } } },
      {
        $lookup: {
          from: 'inventory_checkouts',
          let: { cid: { $toObjectId: '$checkout_id' } },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$cid'] } } },
            { $project: { product_id: 1, hub_id: 1 } },
          ],
          as: 'checkout',
        },
      },
      { $unwind: '$checkout' },
      {
        $group: {
          _id: '$checkout.product_id',
          units: { $sum: '$quantity_sold' },
          revenueCents: { $sum: '$sale_amount_cents' },
        },
      },
      { $sort: { units: -1 } },
    ]).exec();
  },
  /** Revenue per hub since a date (busy-location signal for location recs + hub dashboard). */
  recentHubSales(since: Date) {
    return InventorySaleModel.aggregate<{ _id: string; units: number; revenueCents: number }>([
      { $match: { sold_at: { $gte: since } } },
      {
        $lookup: {
          from: 'inventory_checkouts',
          let: { cid: { $toObjectId: '$checkout_id' } },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$cid'] } } },
            { $project: { hub_id: 1 } },
          ],
          as: 'checkout',
        },
      },
      { $unwind: '$checkout' },
      {
        $group: {
          _id: '$checkout.hub_id',
          units: { $sum: '$quantity_sold' },
          revenueCents: { $sum: '$sale_amount_cents' },
        },
      },
      { $sort: { revenueCents: -1 } },
    ]).exec();
  },

  /**
   * Aggregate settled earnings for a set of sellers (privacy-preserving shelter reporting) —
   * total seller-net and the set of sellers active since `since`. No per-seller detail leaves here.
   */
  async residentEarnings(
    sellerIds: string[],
    since: Date,
  ): Promise<{ totalCents: number; activeSellerIds: string[] }> {
    if (sellerIds.length === 0) return { totalCents: 0, activeSellerIds: [] };
    const rows = await SettlementModel.aggregate<{ _id: null; total: number; active: string[] }>([
      {
        $lookup: {
          from: 'inventory_checkouts',
          let: { cid: { $toObjectId: '$checkout_id' } },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$cid'] } } },
            { $project: { seller_id: 1 } },
          ],
          as: 'checkout',
        },
      },
      { $unwind: '$checkout' },
      { $match: { 'checkout.seller_id': { $in: sellerIds } } },
      {
        $group: {
          _id: null,
          total: { $sum: '$seller_net_cents' },
          active: {
            $addToSet: {
              $cond: [{ $gte: ['$settled_at', since] }, '$checkout.seller_id', '$$REMOVE'],
            },
          },
        },
      },
    ]).exec();
    const row = rows[0];
    return { totalCents: row?.total ?? 0, activeSellerIds: row?.active ?? [] };
  },

  /**
   * Seller earnings feed (GAP-6, S-13). Composes settled payout history (settlements joined to the
   * seller's checkouts), a per-day gross-sales series for the recent window, and pending totals for
   * sales that haven't settled yet. Single seller only — no cross-seller data leaves here.
   */
  async sellerEarnings(
    sellerId: string,
    since: Date,
  ): Promise<{
    settlements: Array<{
      checkoutId: string;
      grossSalesCents: number;
      platformFeeCents: number;
      hubShareCents: number;
      sellerNetCents: number;
      payoutRef: string | null;
      payoutStatus: 'paid' | 'awaiting_funds' | 'no_account' | 'not_applicable';
      settledAt: Date;
    }>;
    dailyGross: Array<{ date: string; grossCents: number; count: number }>;
    lifetimeGrossCents: number;
    pendingGrossCents: number;
    pendingCheckoutCount: number;
  }> {
    const checkouts = await InventoryCheckoutModel.find({ seller_id: sellerId })
      .select({ _id: 1, status: 1 })
      .lean()
      .exec();
    const checkoutIds = checkouts.map((c) => String(c._id));
    if (checkoutIds.length === 0) {
      return {
        settlements: [],
        dailyGross: [],
        lifetimeGrossCents: 0,
        pendingGrossCents: 0,
        pendingCheckoutCount: 0,
      };
    }
    const activeCheckoutIds = checkouts
      .filter((c) => c.status === 'active' || c.status === 'overdue')
      .map((c) => String(c._id));

    const [settlementDocs, dailyRows, lifetime, pending] = await Promise.all([
      SettlementModel.find({ checkout_id: { $in: checkoutIds } })
        .sort({ settled_at: -1 })
        .lean()
        .exec(),
      InventorySaleModel.aggregate<{ _id: string; grossCents: number; count: number }>([
        { $match: { checkout_id: { $in: checkoutIds }, sold_at: { $gte: since } } },
        {
          $group: {
            _id: {
              $dateToString: { format: '%Y-%m-%d', date: '$sold_at', timezone: 'UTC' },
            },
            grossCents: { $sum: '$sale_amount_cents' },
            count: { $sum: '$quantity_sold' },
          },
        },
        { $sort: { _id: 1 } },
      ]).exec(),
      InventorySaleModel.aggregate<{ _id: null; total: number }>([
        { $match: { checkout_id: { $in: checkoutIds } } },
        { $group: { _id: null, total: { $sum: '$sale_amount_cents' } } },
      ]).exec(),
      activeCheckoutIds.length
        ? InventorySaleModel.aggregate<{ _id: null; total: number; count: number }>([
            { $match: { checkout_id: { $in: activeCheckoutIds } } },
            { $group: { _id: null, total: { $sum: '$sale_amount_cents' }, count: { $sum: 1 } } },
          ]).exec()
        : Promise.resolve([]),
    ]);

    return {
      settlements: settlementDocs.map((s) => ({
        checkoutId: s.checkout_id,
        grossSalesCents: s.gross_sales_cents,
        platformFeeCents: s.platform_fee_cents,
        hubShareCents: s.hub_share_cents,
        sellerNetCents: s.seller_net_cents,
        payoutRef: s.seller_payout_ref ?? null,
        payoutStatus: (s.seller_payout_status ?? 'awaiting_funds'),
        settledAt: s.settled_at as Date,
      })),
      dailyGross: dailyRows.map((r) => ({ date: r._id, grossCents: r.grossCents, count: r.count })),
      lifetimeGrossCents: lifetime[0]?.total ?? 0,
      pendingGrossCents: pending[0]?.total ?? 0,
      pendingCheckoutCount: activeCheckoutIds.length,
    };
  },

  // ─── Trust stats (read by the trust module) ─────────────────────────────────────────────────
  async sellerReturnStats(
    sellerId: string,
  ): Promise<{ total: number; onTime: number; late: number }> {
    const rows = await InventoryCheckoutModel.aggregate<{ _id: string; count: number }>([
      { $match: { seller_id: sellerId, status: { $in: ['settled', 'overdue'] } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).exec();
    const settled = rows.find((r) => r._id === 'settled')?.count ?? 0;
    const overdue = rows.find((r) => r._id === 'overdue')?.count ?? 0;
    return { total: settled + overdue, onTime: settled, late: overdue };
  },
};
