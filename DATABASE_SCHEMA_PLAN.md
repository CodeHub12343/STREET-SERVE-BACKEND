# StreetServe — Database Schema Plan (MongoDB)

> Collections, document shapes, relationships, indexes, and the MongoDB-specific integrity strategy.
> **Store:** MongoDB 7+ (Atlas, replica set) via Mongoose 8. **Money:** Stripe Connect authoritative; Mongo holds an itemized mirror.
> Companion: [VALIDATION_RULES.md](VALIDATION_RULES.md), [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md) §3.
> **Source of truth for entities:** `docs/08-database-design.md`. This plan translates that Postgres-oriented design to MongoDB idioms and adds the fields the backend needs.

---

## 0. MongoDB Modeling Principles Applied Here

The source DB doc is relational. Translating to MongoDB is not a 1:1 table→collection copy; we apply document-modeling judgment:

1. **Embed what is read together and owned exclusively; reference what is shared or unboundedly large.**
   - `order_items` → **embedded** array in `orders` (bounded, read with the order).
   - `discount_schedules` → **embedded** array in `businesses` (small, read with the business).
   - `queue_entries`, `messages`, `inventory_sales` → **separate collections** (unbounded growth / independently queried).
2. **Money & inventory integrity uses multi-document transactions + atomic conditional updates**, not foreign keys. See [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md) §3.1.
3. **Geo fields are GeoJSON** (`{ type, coordinates: [lng, lat] }`) with `2dsphere` indexes (replaces PostGIS).
4. **Polymorphic references** (disputes → checkout/transaction/spot_me) use `{ ref_type, ref_id }` pairs.
5. **Immutable financial collections** (`settlements`, completed `transactions`, `audit_logs`) reject in-place updates via Mongoose middleware; corrections are new offsetting docs.
6. **Every document** carries `created_at`, `updated_at` (Mongoose `timestamps`), and `schema_version` for safe evolution.
7. **Referential cleanup** (no cascade in Mongo) is handled by service-layer logic + soft-delete (`status`/`revoked_at`) rather than hard deletes on referenced docs.

Money is **always integer cents** (`Long`), never `Double`.

---

## 1. Identity Domain

### `users`
```jsonc
{
  _id, authProviderId,           // Clerk/Auth0 subject — unique
  email, phone,                  // unique (sparse); one may be null
  display_name, photo_url,
  home_location: { type:"Point", coordinates:[lng,lat] }, // nullable
  location_precision: "exact" | "fuzzed", fuzz_radius_m,  // Security §2
  status: "active" | "suspended" | "deleted",
  account_age_days,              // derived; or compute from created_at
  notification_prefs_id,         // → notification_preferences
  created_at, updated_at, schema_version
}
```
Indexes: `{authProviderId:1} unique`, `{email:1} unique sparse`, `{phone:1} unique sparse`, `{home_location:"2dsphere"}`, `{status:1}`.

### `user_roles`
```jsonc
{ _id, user_id, role:"customer|seller|vendor|hub|shelter_admin|sponsor|admin",
  granted_at, revoked_at:null, granted_by }
```
Indexes: `{user_id:1, role:1} unique partial where revoked_at=null`.
> Alternative: embed `roles: []` in `users`. Kept separate to preserve grant/revoke audit history.

### `verification_records`
```jsonc
{ _id, user_id, tier:"bronze|silver|gold",
  verification_type:"id_document|selfie_liveness|bank_account|shelter_cosign",
  status:"pending|approved|rejected|expired",
  provider:"stripe_identity|persona|stripe_connect",
  provider_reference,            // never the raw document (Security §2)
  verified_at, created_at, updated_at }
```
Indexes: `{user_id:1, verification_type:1}`, `{status:1}`, `{provider_reference:1}`.
**Portable across roles** (Q10). Current effective tier = derived max across approved records.

---

## 2. Vendor / Business Domain

### `businesses`
```jsonc
{
  _id, owner_user_id, name, category_id, description,
  logo_url,                      // customer-facing map pin icon
  cover_photo_url,
  hours: [{ day, open, close }],
  today_special_menu_item_id,    // nullable → menu_items
  service_area: { type:"Point"|"Polygon", coordinates:[...] },
  service_radius_m,              // if point+radius model
  payout_account_ref,            // Stripe Connect account id
  is_hub: false,
  status: "active|suspended",
  discount_schedule: [           // EMBEDDED
    { position:Int, discount_percent:Int, is_cap:Bool }
  ],
  created_at, updated_at
}
```
Indexes: `{owner_user_id:1}`, `{category_id:1}`, `{service_area:"2dsphere"}`, `{is_hub:1}`, text index on `{name, description}` for search.

### `categories`
```jsonc
{ _id, name, parent_category_id:null,
  top_level_tab:"food|coffee|services|shopping|more",
  requires_license:Bool, regulated_by:String|null, active:Bool }
```
Seed: curated ~15–25 rows (Q8). Indexes: `{top_level_tab:1}`, `{parent_category_id:1}`.

### `category_suggestions`
`{ _id, submitted_by_business_id, proposed_name, proposed_parent_category_id, justification, status:"pending|approved|rejected", reviewed_by, reviewed_at }` — approval creates a `categories` row (admin sets `requires_license`/`regulated_by`, never the submitter).

### `license_documents`
`{ _id, business_id, category_id, document_url, status:"pending|approved|rejected", reviewed_by, reviewed_at }` — index `{business_id:1, category_id:1, status:1}`. Gates going live for `requires_license` categories.

### `menu_items`
`{ _id, business_id, name, description, photo_url, price_cents, is_available, created_at }` — index `{business_id:1, is_available:1}`.

---

## 3. Live Map Domain

### `live_sessions`  (durable/auditable last-known; Redis holds the hot mirror)
```jsonc
{ _id, actor_type:"business|seller", actor_id,
  current_location: { type:"Point", coordinates:[lng,lat] },
  status:"driving|parked|away_closed",
  geohash,                       // precomputed cell for bucketing
  started_at, last_ping_at, ended_at:null }
```
Indexes: `{current_location:"2dsphere"}` (most latency-sensitive query), `{status:1, last_ping_at:1}` (stale sweep), `{actor_type:1, actor_id:1}`, `{geohash:1, status:1}`.
> Pop-Up Mode is **not** a status — it's `pop_up_events` (below), triggered on driving→parked with active queue.

### `location_pings`  (high-write history)
`{ _id, session_id, location, recorded_at }` — **TTL index** `{recorded_at:1}` expiring at 30 days (Q7 retention). Consider a **capped/time-series collection**. Never on the hot read path.

### `follows`
`{ _id, follower_user_id, business_id, created_at }` — indexes `{follower_user_id:1, business_id:1} unique`, `{business_id:1}`.

### `notify_me_requests`
`{ _id, user_id, business_id, status:"pending|fulfilled|expired", created_at, fulfilled_at }` — index `{business_id:1, status:1}`.

---

## 4. Queue & Wave-Down Domain

### `wave_downs`
`{ _id, customer_id, target_type:"business|seller", target_id, requested_at(server), status:"pending|accepted|declined|expired", note, eta_seconds, accepted_at, expires_at }`
Indexes: `{target_id:1, status:1, requested_at:1}` (SLA sweeps), `{customer_id:1, requested_at:-1}`.

### `queues`
`{ _id, owner_type:"business|seller", owner_id, status:"open|closed" }`.

### `queue_entries`
`{ _id, queue_id, customer_id, joined_at(server), discount_tier_applied:Int, left_at:null, hold_expires_at }`
- **Position is derived** from `joined_at` ordering, never stored (FR-3.2).
- Discount is **snapshotted** at join into `discount_tier_applied` (FR-3.3), so reflow never changes a locked discount.
Indexes: `{queue_id:1, joined_at:1}` (authoritative order), `{customer_id:1}`.

### `pop_up_events`
`{ _id, business_id, started_at, ended_at, notified_count }`.

### `block_party_events`
`{ _id, centroid: {type:"Point",coordinates}, radius_m, participant_business_ids:[], detected_at, broadcast_at, notified_user_count }` — written by the detection sweep job.

---

## 5. Orders & Scheduling

### `orders`
```jsonc
{ _id, customer_id, business_id,
  status:"pending|accepted|ready|completed|cancelled",
  fulfillment_type:"pickup_now|scheduled", booking_id:null,
  items: [ { menu_item_id, name, quantity, unit_price_cents } ], // EMBEDDED
  subtotal_cents, discount_applied_cents, total_cents, tip_cents, round_up_cents,
  transaction_id, cancelled_reason:null, created_at, ready_at }
```
Indexes: `{business_id:1, status:1}`, `{customer_id:1, created_at:-1}`.
Rule: cannot transition to `ready` while business `live_sessions.status = away_closed`.

### `bookings`
`{ _id, customer_id, business_id, service_id, scheduled_at, status:"booked|completed|cancelled|no_show", recurrence_rule:null, reminder_sent_24h:Bool, reminder_sent_1h:Bool }` — index `{business_id:1, scheduled_at:1}`, `{scheduled_at:1, reminder_sent_24h:1}` for the reminder sweep.

---

## 6. Payments Domain (mirror of Stripe)

### `transactions`
```jsonc
{ _id, customer_id, counterparty_type:"business|seller", counterparty_id,
  amount_cents, discount_applied_cents, tip_cents, round_up_cents,
  platform_fee_cents, tax_cents,
  fee_breakdown: { platform, hub, seller_or_vendor }, // itemized, FR-11.3
  status:"pending|completed|refunded|disputed",
  payment_intent_ref, idempotency_key,
  created_at, completed_at }
```
Indexes: `{counterparty_id:1, created_at:-1}`, `{customer_id:1, created_at:-1}`, `{payment_intent_ref:1} unique`, `{idempotency_key:1} unique sparse`.
**Immutable once `completed`** — refunds/disputes create linked offsetting records.

### `fee_schedule`  (admin-configurable, versioned)
`{ _id, version, effective_at, consignment_fee_bps, membership_overrides, round_up_platform_cut:0, created_by }` — round-up cut is always 0 (FR-6.4).

---

## 7. Consignment Domain

### `hubs`
`{ _id, business_id (1:1 where is_hub), checkout_qr_secret, address, location:{type:"Point"}, hours }` — index `{location:"2dsphere"}`, `{business_id:1} unique`.

### `products`
`{ _id, hub_id, name, category_id, photos:[url], unit_value_cents, consignment_split_percent, return_window_hours, condition_requirements, listing_type:"consignment|wholesale|rental|donation", quantity_available }` — index `{hub_id:1}`, `{category_id:1}`, geo via hub join or denormalized `location` for nearby feed.

### `inventory_checkouts`  ← integrity-critical
```jsonc
{ _id, seller_id, product_id, hub_id, quantity,
  quantity_sold:0,               // maintained by atomic conditional $inc
  condition_photo_url, seller_agreement_version,
  checked_out_at, expected_return_at,
  status:"active|settled|overdue|disputed" }
```
Indexes: `{seller_id:1, status:1}`, `{hub_id:1, status:1}`, `{expected_return_at:1, status:1}` (overdue sweep).
**Oversell guard:** `updateOne({_id, $expr:{$lte:[{$add:["$quantity_sold",n]},"$quantity"]}}, {$inc:{quantity_sold:n}})`; `matchedCount===0` → `409 OVERSELL`.

### `inventory_sales`
`{ _id, checkout_id, quantity_sold, sale_amount_cents, sold_at, proof_photo_url, logged_via:"qr_scan|manual" }` — index `{checkout_id:1}`.

### `inventory_returns`
`{ _id, checkout_id, quantity_returned, condition_photo_url, returned_at, condition_assessment:"good|damaged|lost" }`.

### `settlements`  ← immutable
`{ _id, checkout_id, gross_sales_cents, platform_fee_cents, hub_share_cents, seller_net_cents, payout_ref, settled_at }` — invariant `seller_net = gross − platform_fee − hub_share`; append-only, corrections via new offsetting doc.

---

## 8. Trust, Reviews, Disputes

### `trust_scores`  (per role, not per user — Q10)
`{ _id, subject_type:"seller|business|hub", subject_id, score:0-100, formula_version, inputs:{ unresolved_dispute_rate, late_return_rate, on_time_rate, avg_review }, computed_at }` — index `{subject_type:1, subject_id:1, computed_at:-1}`.

### `reviews`
`{ _id, author_id, subject_type:"business|seller", subject_id, rating:1-5, comment, transaction_id (required), created_at }` — index `{subject_type:1, subject_id:1}`, `{transaction_id:1} unique` (one review per transaction; anti-manipulation).

### `disputes`
`{ _id, subject_type:"seller|business|hub", subject_id, related:{ ref_type:"checkout|transaction|spot_me", ref_id }, opened_by, status:"open|evidence_requested|resolved", evidence:[{url,note,by,at}], resolution, resolved_at, sla_due_at }` — index `{status:1, sla_due_at:1}` (SLA-breach alerting).

---

## 9. Growth Domain

### `pings`
`{ _id, sender_user_id, recipient_contact_hash, business_id, is_paid, tip_amount_cents, device_fingerprint, qualifying_action_completed_at, tip_paid_at, created_at }`
Indexes: `{business_id:1, recipient_contact_hash:1} unique partial where is_paid=true` (one tip per unique recipient per vendor ever), `{sender_user_id:1, created_at:1}` (daily cap), `{device_fingerprint:1}`.

### `ping_budgets`
`{ _id, business_id, balance_cents, per_share_tip_cents, status:"active|paused" }`.

### `gifts`
`{ _id, sender_id, recipient_contact, transaction_id, redemption_code(unique), status:"pending|redeemed|expired", expires_at, expiry_notice_sent }`.

### `giveaways`
`{ _id, business_id, product_name, daily_quantity_cap, quantity_claimed_today, reset_at }`.

### `spot_me_requests`
`{ _id, requester_id, counterparty_type:"vendor|peer", counterparty_id, amount_cents, repay_by, status:"pending|accepted|declined|repaid|defaulted", decided_at }` — blocked at creation if requester `account_age_days<30` or tier `<bronze`.

---

## 10. Jobs, Shelter, AI

- **`jobs_postings`** `{ _id, poster_business_id:null, title, description, location:{type:"Point"}, pay_cents, pay_unit:"flat|hourly", status:"open|filled|cancelled" }` — `{location:"2dsphere"}`, `{status:1}`.
- **`job_applications`** `{ _id, job_id, applicant_id, status:"applied|accepted|checked_in|completed|no_show", checked_in_at, checked_out_at, payout_ref }`.
- **`shelter_partners`** `{ _id, organization_name, verified_by_admin_id, verified_at, status }`.
- **`shelter_enrollments`** `{ _id, shelter_partner_id, resident_user_id, cosigned_allocation_cents, enrolled_at, staff_verifier_name }` — `cosigned_allocation_cents` = **hard liability cap** (FR-12.4).
- **`ai_recommendations`** `{ _id, seller_id, recommendation_type:"product|location|pricing", payload, reason_summary, shown_at, accepted:null }`.

---

## 11. Reputation-adjacent, Sponsors, Ops

- **`sponsors`** `{ _id, name, logo_url, tier, launch_city_id, impressions_count, attributed_signups_count }`.
- **`cities`** `{ _id, name, state, status:"pre_launch|live", launch_date, feature_flags }` — city-scoping for expansion.
- **`preregistrations`** `{ _id, full_name, email, phone, intended_role, city_id, created_at }` — carry-over of marketing waitlist.
- **`notification_preferences`** `{ _id, user_id, channels_by_category:{...}, unmutable:["payout","dispute","verification"] }`.
- **`notifications`** (log) `{ _id, user_id, category, channel, payload, status, sent_at }`.
- **`audit_logs`** (immutable) `{ _id, actor_id, actor_role, action, entity_type, entity_id, reason, metadata, created_at }` — index `{entity_type:1, entity_id:1, created_at:-1}`, `{actor_id:1}`.
- **`fraud_flags`** `{ _id, type:"ping|oversell|spot_me|duplicate_account", subject_id, signals, status:"open|reviewed|dismissed", created_at }`.
- **`message_threads`** `{ _id, customer_id, business_id, last_message_at }`; **`messages`** `{ _id, thread_id, sender_user_id, body, read_at, created_at }` — `{thread_id:1, created_at:1}`, `{business_id:1, last_message_at:-1}`.
- **`idempotency_keys`** (or Redis) `{ key, response_hash, created_at, ttl }`.

---

## 12. Relationship Summary (references, since Mongo has no FKs)

- `users` 1—N `user_roles`, `verification_records`, `businesses` (owner), `transactions` (customer).
- `businesses` 1—1 `hubs` (optional), 1—N `products`, `queues`, `live_sessions`, `menu_items`; embeds `discount_schedule`.
- `products` 1—N `inventory_checkouts` 1—N `inventory_sales`, 1—1 `inventory_returns`, 1—1 `settlements`.
- `queues` 1—N `queue_entries`.
- `disputes` polymorphic → `inventory_checkouts` | `transactions` | `spot_me_requests`.
- `shelter_partners` 1—N `shelter_enrollments` 1—1 `users`.
- **Enforcement of these relationships is service-layer + transactional**, not database-enforced. See [VALIDATION_RULES.md](VALIDATION_RULES.md).

---

## 13. Index Strategy Summary (the latency-critical ones)

| Collection | Index | Purpose |
|---|---|---|
| live_sessions | `current_location: 2dsphere` | Proximity/radius — hottest query |
| live_sessions | `status, last_ping_at` | Stale-session sweep |
| live_sessions | `geohash, status` | Bucketed subscriptions / Block Party candidates |
| queue_entries | `queue_id, joined_at` | Authoritative position (FR-3.2) |
| wave_downs | `target_id, status, requested_at` | SLA expiry sweeps |
| inventory_checkouts | `seller_id, status` / `hub_id, status` | Both dashboards |
| inventory_checkouts | `expected_return_at, status` | Overdue sweep |
| transactions | `payment_intent_ref` unique; `idempotency_key` unique | Dedupe/idempotency |
| pings | `business_id, recipient_contact_hash` unique partial | One tip per recipient ever |
| disputes | `status, sla_due_at` | SLA-breach alerting |
| trust_scores | `subject_type, subject_id, computed_at desc` | Latest-score lookup |
| reviews | `transaction_id` unique | One review per transaction |
| follows | `follower_user_id, business_id` unique | Dedupe / Favorites |
| products/hubs/jobs | `location: 2dsphere` | Nearby feeds |

All indexes are created via reviewable `migrate-mongo` migrations, never implicit `ensureIndex` at runtime in production.
