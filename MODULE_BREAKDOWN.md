# StreetServe — Backend Module Breakdown

> Every backend module, its responsibilities, owned collections, emitted/consumed events, and dependencies.
> Companion: [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md), [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md), [BACKEND_FEATURE_INVENTORY.md](BACKEND_FEATURE_INVENTORY.md).

A **module** = a cohesive domain slice with its own routes/controller/service/repository/model. A module's public surface is its **service methods** and the **events** it emits. Modules never reach into another module's repository/model.

---

## Module Dependency Graph (high level)

```
                         identity (users, roles, verification)
                              ▲            ▲            ▲
        ┌─────────────────────┘            │            └───────────────┐
     vendors ──────► livemap ──────► queue ─┤                        payments
        │              │              │     │                            ▲
        │              ▼              ▼     ▼                            │
      orders       scheduling     growth (ping/gift/spotme/giveaway)     │
        │              │              │                                  │
        └──────────────┴──────────────┴───────────► transactions ────────┘
                                                        │
   consignment (hub/product/checkout/settlement) ───────┤
        │                                               ▼
        ├────────► trust ◄──── disputes            notifications ◄── (all)
        │            ▲                                  ▲
      jobs           │                                  │
      shelter ───────┘                             realtime gateway
      ai (reads trust/consignment/livemap)         admin (reads all)
```

Foundational modules (**identity**, **payments**, **notifications**, **realtime**, **audit**) are depended on by nearly everything; they must be built first (see [BACKEND_IMPLEMENTATION_ROADMAP.md](BACKEND_IMPLEMENTATION_ROADMAP.md)).

---

## 1. `identity`
**Responsibility:** Accounts, the additive multi-role model, and KYC verification tiers.
- Sync users from Clerk/Auth0 (webhook + JIT on first authenticated request).
- Additive roles on one identity (`customer | seller | vendor | hub | shelter_admin | sponsor | admin`) — roles are capabilities, not separate accounts (docs §Roles).
- Tiered verification (Tier 0/Bronze/Silver/Gold): proxy ID/selfie to KYC provider, link bank via Stripe Connect onboarding, store only provider references + status.
- **Verification is portable across roles** (Q10); **Trust scores are per-role** (owned by `trust`).
- Shelter-cosign alternate verification path entry point (delegates cosign to `shelter`).

**Owns:** `users`, `user_roles`, `verification_records`.
**Emits:** `user.created`, `role.granted`, `verification.tier_changed`.
**Depends on:** integrations/auth, integrations/kyc, payments (bank link), shelter (cosign).

## 2. `vendors`
**Responsibility:** Business entities, categories, license gating, menus, hub flag.
- Business profile CRUD (logo = map pin icon), hours, Today's Special, service area.
- Category taxonomy (curated ~15–25) + `category_suggestions` (admin-approved, never self-service).
- License gating: `requires_license` category blocks going live until an approved `license_documents` row exists (FR/DB validation).
- Menu items (direct-order/wave-down catalog — distinct from consignment products).

**Owns:** `businesses`, `categories`, `category_suggestions`, `license_documents`, `menu_items`.
**Emits:** `business.created`, `license.approved`, `category_suggestion.submitted`.
**Depends on:** identity, payments (payout account ref), admin (review actions).

## 3. `livemap`
**Responsibility:** Live location sessions, the three-state status model, proximity, nearby feed.
- `live_sessions` with status `driving | parked | away_closed` (Pop-Up is an *event*, not a status).
- Location ingest (≥ every 10s server-side, FR-1.2): write to Redis hot mirror; throttled snapshot to Mongo; TTL ping-history.
- `/map/nearby` proximity + category + search; geohash-bucketed subscriptions.
- Proximity alerts (FR-1.4, throttled 1/vendor/2h), Follow status-change alerts, Notify-Me one-off.
- License gate + `away_closed` interlocks with orders/queue.

**Owns:** `live_sessions`, `follows`, `notify_me_requests`, (Redis) location hot state.
**Emits:** `live_session.started/stopped`, `live_session.location_updated`, `live_session.status_changed`, `popup.triggered`.
**Depends on:** vendors, identity, notifications, realtime.

## 4. `queue`
**Responsibility:** Wave-down and the line-up discount engine.
- Wave-down request/accept/decline/expire (SLA 2–15 min, default 5), ETA + live tracking on accept.
- Server-timestamp-authoritative queue position (FR-3.2); discount **locked at join** (FR-3.3); configurable geofence-leave hold (default 15 min).
- Discount schedule: strictly increasing by position + exactly one cap row.
- Pop-Up delay-notification side effect on driving→parked with active queue.

**Owns:** `wave_downs`, `queues`, `queue_entries`, `discount_schedules`, `pop_up_events`.
**Emits:** `wave_down.created/accepted/declined/expired`, `queue.joined/left`, `popup.notified`.
**Depends on:** livemap, notifications, realtime, vendors.

## 5. `orders`
**Responsibility:** Direct orders from a menu for pickup (distinct from wave-down and booking).
- Order lifecycle pending→accepted→ready→completed/cancelled; `ready` blocked while `away_closed`.
- Partial fulfilment / out-of-stock handling (never silent substitution).

**Owns:** `orders`, `order_items`.
**Emits:** `order.placed/accepted/ready/cancelled`.
**Depends on:** vendors (menu), payments (charge), livemap (status), notifications.

## 6. `payments`
**Responsibility:** All money movement, the single boundary to Stripe Connect + Stripe Tax.
- PaymentIntents (card/wallet), discount + round-up (round-up = 100% to vendor, no platform cut, FR-6.4), tips.
- Connected-account onboarding, delayed/instant payouts by tier (Bronze 3d / Silver next-day / Gold instant, FR-11.2), split transfers.
- Marketplace-facilitator sales tax via Stripe Tax.
- Itemized fee split visible to all parties (FR-11.3); idempotency keys mandatory; immutable transaction/settlement mirror.
- Webhook ingestion (PaymentIntent, transfer, payout, tax) → reconcile ledger.

**Owns:** `transactions` (mirror/ledger), Stripe references. Settlement math is computed in `consignment` but **executed** here.
**Emits:** `transaction.completed/refunded`, `payout.issued`, `payout.reversed`.
**Depends on:** integrations/stripe. Consumed by nearly every transactional module.

## 7. `consignment`
**Responsibility:** The full hub→product→checkout→sale→return→settlement lifecycle.
- Hub registration, product catalog (unit value, split %, return window, condition, listing type).
- QR checkout (condition photo), reservation, seller live pin (via livemap).
- **Oversell guard** (atomic conditional update, FR-8.3); real-time inventory decrement.
- Return + reconcile; **settlement math** (gross − platform fee − hub share = seller net), disbursed via `payments` per tier; immutable settlement rows.
- Return-deadline grace reminder → Trust penalty + reservation-limit reduction (FR-8.5).
- Seller Agreement clickwrap (bailment model) enforced at checkout (FR-8.6).

**Owns:** `hubs`, `products`, `inventory_checkouts`, `inventory_sales`, `inventory_returns`, `settlements`.
**Emits:** `inventory.checked_out`, `inventory.sold`, `inventory.returned`, `inventory.settled`, `inventory.overdue`.
**Depends on:** vendors, identity (tier), payments, trust, livemap, storage.

## 8. `trust`
**Responsibility:** Per-role reputation scoring + reviews.
- Versioned, explainable Trust Score formula (FR-10.1); per-role (seller/business/hub) not per-user (Q10).
- Recompute nightly + on every settlement/dispute resolution; **dispute-driven changes applied only post-resolution** (FR-10.3).
- Reviews tied to a completed transaction only (anti-manipulation).

**Owns:** `trust_scores`, `reviews`.
**Emits:** `trust_score.recomputed`.
**Depends on:** consignment, disputes, payments (events), notifications.

## 9. `disputes`
**Responsibility:** Formal dispute case objects + SLA tracking.
- Case status open→evidence_requested→resolved; SLA default 5 business days; evidence upload; admin-only resolution.
- Polymorphic subject (checkout/transaction/spot_me); clawback via documented reversal only (never silent debit).

**Owns:** `disputes`.
**Emits:** `dispute.opened/evidence_requested/resolved`.
**Depends on:** payments (clawback), trust (post-resolution score change), storage, admin, notifications.

## 10. `growth`
**Responsibility:** Ping-to-ping sharing, gifting, giveaways, Spot Me — the fraud-sensitive mechanics.
- Paid ping budgets; per-share tip; qualifying-action gate; per-account daily cap (default 10, FR-5.3); one tip per unique recipient per vendor ever; device fingerprint dedupe.
- Gifting (redemption code, expiry, pre-expiry notice); giveaways (daily cap, no payment).
- Spot Me (Trust-Score-informed, blocked < 30-day age or < Bronze; default = reputation consequence, not collections).

**Owns:** `pings`, `ping_budgets`, `gifts`, `giveaways`, `spot_me_requests`.
**Emits:** `ping.logged/qualified`, `gift.created/redeemed`, `spot_me.requested/decided/repaid/defaulted`, `fraud.flag_raised`.
**Depends on:** payments, trust, identity, notifications; heavy on rate-limit + fraud services.

## 11. `scheduling`
**Responsibility:** Bookings/calendar.
- Slot exposure, book/reschedule/cancel (vendor cutoff), reminders (24h + 1h, FR-7.2), no-show as Trust input, recurrence.

**Owns:** `bookings`.
**Emits:** `booking.created/rescheduled/cancelled/no_show`.
**Depends on:** vendors, notifications, trust.

## 12. `jobs`
**Responsibility:** "Earn Today" gig postings (V1.x).
- Nearby ranked postings, apply/accept, QR/geofence check-in/out → same-day payout.
- **Pilot note:** passive background geofence is native-only; pilot uses explicit in-app tap check-in (docs §12).

**Owns:** `jobs_postings`, `job_applications`.
**Emits:** `job.posted`, `job.checked_in/out/completed`.
**Depends on:** identity, payments, livemap, notifications.

## 13. `shelter`
**Responsibility:** Homeless Shelter Partner Program (V1.x).
- Admin-verified partner orgs; in-person resident cosign at Tier-1-equivalent; `cosigned_allocation_cents` as hard liability cap (FR-12.4).
- Aggregate-only, privacy-preserving reporting (FR-12.3).

**Owns:** `shelter_partners`, `shelter_enrollments`.
**Emits:** `shelter_partner.verified`, `resident.enrolled`.
**Depends on:** identity (verification path), consignment (allocation), admin.

## 14. `ai`
**Responsibility:** Rule-based v1 recommendations + coaching (Milestone 5).
- Product/location recs = category affinity + proximity + time-of-day heuristics, each with a `reason_summary` (explainable, FR-9.1); advisory only (FR-9.2).
- Pricing suggestion; sales-coaching content library keyed to objection categories (FR-9.3).
- **Boundary drawn for future extraction** to a Python FastAPI microservice once real data justifies ML (docs §3) — behind a stable internal interface.

**Owns:** `ai_recommendations`, coaching content.
**Emits:** `recommendation.shown`.
**Depends on:** consignment, livemap, trust (read-only).

## 15. `notifications`
**Responsibility:** Unified multi-channel delivery + per-category preferences.
- Channels: Socket.IO (in-app), FCM (push), Twilio SMS (the background-blocked bridge for proximity/Block Party/etc.), Postmark (email).
- Per-category mute settings; safety-critical (payout/dispute/verification) cannot be fully muted, only redirected to email (Flow 12).
- Fan-out via BullMQ (e.g., Block Party broadcast).

**Owns:** `notification_preferences`, `notifications` (log).
**Consumes:** events from every module.
**Depends on:** all integrations/push/sms/email, realtime.

## 16. `admin`
**Responsibility:** Trust & Safety + Ops/Finance tooling (least-privilege, tiered).
- Category/license review, dispute queue, account suspension, fraud-flag review, payout holds, fee schedule, sponsor + preregistration management, reconciliation reports.
- Every admin action writes an `audit_logs` entry.

**Owns:** `sponsors`, `cities`, `preregistrations`, `audit_logs`, `fraud_flags`.
**Depends on:** read/act across all modules; strongest RBAC surface.

## 17. `realtime` (gateway, not a domain module)
**Responsibility:** Socket.IO server, namespaces (`/live`, `/queue/:id`, `/notifications/:userId`, `/messages/:threadId`), handshake auth, room authorization, Redis adapter. Translates domain events → client emits. See [REALTIME_ARCHITECTURE.md](REALTIME_ARCHITECTURE.md).

## 18. `messaging`
**Responsibility:** Scoped customer↔business threads (and reused for seller/Spot-Me contexts). Rate-limited + moderated like reviews; not a general DM system.
**Owns:** `message_threads`, `messages`.
**Emits:** `message.sent`.
**Depends on:** vendors, identity, realtime, notifications.

---

## Shared/foundational (not domain modules)
- **`payments` boundary**, **`audit`** (append-only writer), **`events` bus**, **`integrations/*` adapters**, **`shared` utils** (money, geo, pagination, errors). Built in Milestone 0.
