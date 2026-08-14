# StreetServe — Validation Rules

> Two enforcement layers: **Zod** at the HTTP edge (shape, type, presence, ranges, unknown-field rejection) and **service/transaction-layer invariants** for cross-document and business rules MongoDB cannot express as constraints. Mongoose schema validation is the storage backstop.
> Companion: [DATABASE_SCHEMA_PLAN.md](DATABASE_SCHEMA_PLAN.md), [ERROR_HANDLING_STRATEGY.md](ERROR_HANDLING_STRATEGY.md).

---

## 1. Enforcement Layer Model

| Layer | Enforces | Failure code |
|---|---|---|
| **Zod (edge)** | Field presence, types, formats, enum membership, numeric ranges, string length, unknown-field rejection, cursor/pagination params | `400 VALIDATION_ERROR` |
| **RBAC guard** | Role + resource-ownership | `403 FORBIDDEN` |
| **Service invariants** | Cross-document business rules, atomic guards, state-machine transitions | `409 CONFLICT` / `422 BUSINESS_RULE` |
| **Mongoose schema** | Storage backstop (types, required, enums) — defense in depth, never the only line | `500` (indicates a bug upstream) |

**Global rules:**
- All money is integer cents; reject non-integer or negative where a positive amount is required.
- Unknown request-body fields are rejected (`.strict()` Zod objects) — prevents mass-assignment.
- All geo input validated as GeoJSON with `[lng, lat]` order, lng ∈ [-180,180], lat ∈ [-90,90].
- All list endpoints: `limit` ∈ [1,100] (default 20), `cursor` opaque base64 — offset pagination rejected.
- Idempotency-Key required (non-empty, ≤255 chars) on every payment-mutating POST.

---

## 2. Per-Domain Validation Rules

### Identity
- `register`: exactly one of email/phone required; phone E.164; email RFC-valid.
- `add role`: target role ∈ enum; cannot self-grant `admin` (admin roles granted only by existing admin, audited).
- Verification tier is derived (max approved record), never client-settable.
- `verification.bank-account`: only initiates Stripe Connect onboarding link; never accepts raw bank fields.

### Vendors / Categories
- `business.category_id` must reference an `active` category.
- Going live (`live_sessions.start`) is **blocked** if the business's category has `requires_license=true` and no `license_documents` row with `status=approved` exists for that `(business_id, category_id)` → `422 LICENSE_REQUIRED`.
- `category_suggestions`: submitter cannot set `requires_license`/`regulated_by` — admin-only on approval.
- `menu_items.price_cents` ≥ 0; `today_special_menu_item_id`, if set, **must belong to the same business** (service-layer check).

### Live Map
- `location tick`: rejected if no active `live_session` owned by the actor.
- Status transitions constrained to the 3-state model; Pop-Up is derived (driving→parked with active queue), never a settable status.
- Proximity alert throttle: max 1 per (vendor, user) per rolling 2h (FR-1.4) — enforced via Redis counter, not just at write.

### Queue / Discount
- `discount_schedule`: `discount_percent` **strictly increasing** by `position`; **exactly one** row with `is_cap=true`; percents ∈ [0,100] → reject at business update time.
- `queue join`: `joined_at` is **server-assigned**, client value ignored (FR-3.2). Simultaneous joins resolved by server receipt order.
- Discount tier is **snapshotted at join** into `discount_tier_applied`; never recomputed on read (FR-3.3).
- Wave-down SLA (`expires_at`) between 2–15 min (default 5); accept/decline rejected if already expired.

### Orders
- `order.items` non-empty; each `menu_item_id` belongs to the order's business and `is_available=true` at order time.
- `total_cents === subtotal_cents − discount_applied_cents + tip_cents + round_up_cents` (service-layer, computed server-side — client totals ignored).
- Transition to `ready` **rejected** if business's current `live_sessions.status = away_closed` → `422 BUSINESS_AWAY`.
- Out-of-stock after order → partial-fulfil or line cancel with customer notification; never silent substitution.

### Payments
- Amounts server-computed; client-supplied price/discount/fee **never trusted**.
- Discount applied server-side from the locked queue tier, not client input.
- Round-up: platform cut = 0 (FR-6.4) — enforced in fee computation, not configurable to nonzero.
- Idempotency-Key: duplicate key returns the cached first response, never a second charge.
- `transactions`: immutable once `completed`; refund/dispute create linked offsetting docs (Mongoose pre-update hook rejects mutation of completed rows).

### Consignment (integrity-critical)
- **Checkout requires** an accepted current-version Seller Agreement (`seller_agreement_version` stamped) at Tier 1 (FR-8.6) → else `422 AGREEMENT_REQUIRED`.
- Checkout requires seller verification tier appropriate to product value; low-value only at Bronze (Flow 1b).
- **Oversell guard (FR-8.3):** a sale is applied only via the atomic conditional update `sum(quantity_sold)+n ≤ quantity`. `matchedCount===0` → `409 OVERSELL`, and a `fraud_flags` entry if the attempt exceeds a threshold.
- `inventory_sales.quantity_sold` > 0; `sale_amount_cents` ≥ 0.
- **Settlement invariant:** `seller_net_cents = gross_sales_cents − platform_fee_cents − hub_share_cents`, computed server-side; row **immutable** once written; corrections only via a new offsetting settlement doc (audit requirement).
- Missed return: after `expected_return_at` + grace (default 24h) → penalty + reservation-limit reduction (FR-8.5).

### Trust / Reviews / Disputes
- Trust Score clamped to [0,100]; `formula_version` recorded on every computation.
- **Dispute-driven score changes applied only after `status=resolved`** (FR-10.3) — never pre-emptively.
- `reviews`: `transaction_id` required and must reference a `completed` transaction involving the author (anti-manipulation, Security §4); rating ∈ [1,5].
- `disputes.resolve`: admin-only; sets `resolved_at`; triggers post-resolution trust recompute.
- Clawback of an already-issued payout only via documented reversal (both parties notified) — never a silent debit (Edge case §4).

### Growth
- Spot Me creation **blocked** if `account_age_days < 30` or verification `< bronze` → `422 SPOT_ME_INELIGIBLE`.
- Paid ping tip qualifies only if recipient is new or 90-day-dormant AND completes qualifying action within 24h (FR-5.2).
- Per-account paid-share daily cap (default 10, FR-5.3) → `429` past cap.
- Unique `(business_id, recipient_contact_hash)` for paid pings — one tip per unique recipient per vendor ever (partial unique index + service check).
- Giveaway claim rejected past `daily_quantity_cap` for the day.
- Gift redemption rejected if `expired` or already `redeemed`.

### Scheduling
- Reschedule/cancel rejected past the vendor-configured cutoff.
- No-show markable only after `scheduled_at`.

### Jobs / Shelter
- Job check-in requires geofence proximity (or QR) match; check-out required before payout.
- Shelter partner must be `verified` before it can cosign (FR-12.1).
- Resident allocation cannot exceed `cosigned_allocation_cents`; a default writes off/recovers only against that cap (FR-12.4) — never broader.
- Shelter reporting endpoint returns aggregates only; per-resident detail requires explicit resident consent (FR-12.3).

---

## 3. State Machines (transition validation)

Rejected transitions return `409 INVALID_STATE_TRANSITION`.

- **wave_down:** `pending → accepted | declined | expired` (terminal).
- **order:** `pending → accepted → ready → completed`; `pending|accepted → cancelled`.
- **live_session status:** `driving ↔ parked ↔ away_closed` (any-to-any; Pop-Up is a derived event on driving→parked).
- **inventory_checkout:** `active → settled | overdue | disputed`; `overdue → settled | disputed`.
- **dispute:** `open → evidence_requested → resolved`; `open → resolved`.
- **spot_me:** `pending → accepted → repaid | defaulted`; `pending → declined`.
- **transaction:** `pending → completed → refunded | disputed`.
- **booking:** `booked → completed | cancelled | no_show`.

---

## 4. Representative Zod Schemas (illustrative)

```ts
// POST /wave-downs
const CreateWaveDown = z.object({
  targetType: z.enum(["business","seller"]),
  targetId: z.string().length(24),
  location: z.object({ type: z.literal("Point"),
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]) }),
  note: z.string().max(280).optional(),
}).strict();

// POST /checkouts/:id/sales
const LogSale = z.object({
  quantitySold: z.number().int().positive(),
  saleAmountCents: z.number().int().nonnegative(),
  loggedVia: z.enum(["qr_scan","manual"]),
  proofPhotoUrl: z.string().url().optional(),
}).strict();

// POST /spot-me
const CreateSpotMe = z.object({
  counterpartyType: z.enum(["vendor","peer"]),
  counterpartyId: z.string().length(24),
  amountCents: z.number().int().positive(),
  repayBy: z.string().datetime(),
}).strict(); // service layer additionally enforces age≥30 & tier≥bronze
```

---

## 5. Validation Anti-Patterns to Avoid
- ❌ Trusting client-reported queue position, discount, price, fee, or role.
- ❌ Read-then-write for the oversell guard (race condition) — use the atomic conditional update.
- ❌ In-place updates to `settlements`/completed `transactions`/`audit_logs`.
- ❌ Float money math anywhere.
- ❌ Relying solely on Mongoose schema for cross-document invariants (it can't see other docs).
- ❌ Offset pagination on live/continuously-inserted collections.
