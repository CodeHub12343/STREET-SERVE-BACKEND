# StreetServe — Backend Feature Inventory

> Complete inventory of backend-owned features, grouped by module, tiered MVP / V1.x / Future, cross-referenced to the source FRs.
> Legend: **MVP** = pilot launch (Modesto, CA) · **V1.x** = post-pilot · **Future** = named but unscoped.
> Companion: [MODULE_BREAKDOWN.md](MODULE_BREAKDOWN.md), [BACKEND_IMPLEMENTATION_ROADMAP.md](BACKEND_IMPLEMENTATION_ROADMAP.md).

This inventory is backend-scoped: it lists the server capabilities behind each product feature, including the **implicit/hidden requirements** the source docs surfaced (§4 of the Executive Summary) that must exist for the explicit features to work.

---

## A. Identity, Roles & Verification

| # | Feature | Tier | Source |
|---|---|---|---|
| A1 | Account creation + OTP (email/phone) via managed auth | MVP | Flow 1, API §1 |
| A2 | Additive multi-role model on one identity | MVP | Roles §, Design rule |
| A3 | Add-role endpoint (customer→seller→vendor) without new account | MVP | API §1, Flow 1 |
| A4 | Tiered seller verification Tier 0/Bronze/Silver/Gold | MVP | Flow 1b, FR-11.2 |
| A5 | KYC ID + selfie liveness (provider-hosted, reference-only storage) | MVP | FR-1b, Security §2 |
| A6 | Bank account link via Stripe Connect onboarding | MVP | Flow 1b, API §1 |
| A7 | Verification portability across roles (Q10) | MVP | DB §1, Q10 |
| A8 | Vendor/business verification + category-license gating | MVP | Flow 1c |
| A9 | Shelter-cosign alternate verification path | V1.x | Flow 1b, FR-12 |
| A10 | Account suspension / status lifecycle | MVP | Roles §, API §14 |

## B. Live Map & Location (hot path)

| # | Feature | Tier | Source |
|---|---|---|---|
| B1 | Live session start/stop; 3-state status (driving/parked/away_closed) | MVP | FR-1, Flow 2a |
| B2 | Location ingest ≥ every 10s; Redis hot mirror + throttled Mongo snapshot | MVP | FR-1.2 |
| B3 | Nearby pins query (radius + category tab + free-text search) | MVP | FR-1.1/1.3, API §3 |
| B4 | Geohash-bucketed pin subscriptions (bounded fan-out) | MVP | Security §7 |
| B5 | Proximity alerts (opt-in, throttled 1/vendor/2h) | MVP | FR-1.4 |
| B6 | Follow (persistent, Favorites, status-change alerts) | MVP | Flow 2b |
| B7 | Notify-Me (one-off next-time-nearby alert) | MVP | Flow 2b |
| B8 | Pop-Up Mode as driving→parked event + delay notification | MVP | FR-4.1, Flow 2 |
| B9 | Location fuzzing / user-controlled precision | MVP | Security §2, Privacy NFR |
| B10 | Block Party detection (≥2 vendors, radius+time) + broadcast | V1.x | FR-4.2 |

## C. Wave Down & Queue / Discount Engine

| # | Feature | Tier | Source |
|---|---|---|---|
| C1 | Wave-down request/accept/decline/expire (configurable SLA) | MVP | FR-2 |
| C2 | ETA estimate + live tracking on accept | MVP | FR-2.3 |
| C3 | Server-timestamp-authoritative queue positioning | MVP | FR-3.2 |
| C4 | Discount schedule (increasing tiers + single cap) | MVP | FR-3.1 |
| C5 | Discount locked at join, honored through reflow | MVP | FR-3.3 |
| C6 | Geofence-leave hold (configurable, default 15m) | MVP | FR-3.4 |

## D. Orders, Menu & Scheduling

| # | Feature | Tier | Source |
|---|---|---|---|
| D1 | Menu item CRUD + Today's Special | MVP | Flow 2d, API §4b |
| D2 | Direct order (pickup-now) lifecycle | MVP | Flow 2d |
| D3 | Order `ready` blocked while away_closed; partial-fulfil handling | MVP | FR/DB validation |
| D4 | Bookings: book/reschedule/cancel + cutoff | MVP | FR-7 |
| D5 | Booking reminders (24h + 1h), no-show → Trust input | MVP | FR-7.2, Flow 6 |
| D6 | Recurring bookings / calendar sync | V1.x | Feature breakdown |

## E. Payments, Tips, Gifting, Spot Me

| # | Feature | Tier | Source |
|---|---|---|---|
| E1 | Standard transaction (card/wallet) + server-side discount application | MVP | FR-11, Flow 5 |
| E2 | Round-up tip (100% to vendor, no platform cut) | MVP | FR-6.4 |
| E3 | Tiered payout timing (Bronze 3d/Silver next-day/Gold instant) | MVP | FR-11.2 |
| E4 | Itemized fee split on every receipt | MVP | FR-11.3 |
| E5 | Idempotency keys on all payment POSTs | MVP | API §16 |
| E6 | Escrow/connected-account model (no fund co-mingling) | MVP | FR-11.1 |
| E7 | Marketplace-facilitator sales tax (Stripe Tax) | MVP | FR NFR, Q3 |
| E8 | Gifting (redemption code, expiry, pre-expiry notice) | V1.x | FR-6.1 |
| E9 | Giveaways (daily cap, no payment) | V1.x | FR-6.2 |
| E10 | Spot Me (Trust-informed, age/tier gated, reputation consequence) | V1.x | FR-6.3 |

## F. Ping-to-Ping Growth Economy

| # | Feature | Tier | Source |
|---|---|---|---|
| F1 | Paid-sharing budget fund/pause/adjust | V1.x | FR-5.1 |
| F2 | Ping log + qualifying-action tip gating | V1.x | FR-5.2 |
| F3 | Per-account daily paid-share cap (default 10) | V1.x | FR-5.3 |
| F4 | One-tip-per-unique-recipient-per-vendor-ever constraint | V1.x | Business rules, DB §6 |
| F5 | Device-fingerprint duplicate detection + fraud-flag queue | V1.x | Security §4 |
| F6 | Free-share fallback when budget depleted | V1.x | FR-5.4 |

## G. Consignment Lifecycle (financial + chain-of-custody)

| # | Feature | Tier | Source |
|---|---|---|---|
| G1 | Hub registration + product catalog upload | MVP | Flow 8, FR-8.1 |
| G2 | Inventory browse/reservation (seller-facing nearby feed) | MVP | Flow 7 |
| G3 | QR checkout-in with condition photo | MVP | FR-8.2 |
| G4 | Oversell guard (atomic, transaction-layer) | MVP | FR-8.3 |
| G5 | Real-time per-seller/per-product inventory tracking | MVP | FR-8.3 |
| G6 | Sale logging (qr/manual + proof photo) | MVP | Flow 7 |
| G7 | QR return-in + condition assessment | MVP | FR-8, Flow 7 |
| G8 | Automatic settlement math + tiered payout | MVP | FR-8.4 |
| G9 | Missed-return grace reminder → penalty + limit reduction | MVP | FR-8.5 |
| G10 | Seller Agreement clickwrap (bailment) at Tier 1 | MVP | FR-8.6 |
| G11 | Hub early-recall flow | V1.x | Flow 8 edge |
| G12 | Offline-tolerant seller checkout (queue+sync) | V1.x (rec.) | Feature breakdown |

## H. Trust, Reviews & Disputes

| # | Feature | Tier | Source |
|---|---|---|---|
| H1 | Versioned, explainable Trust Score (per role) | MVP | FR-10.1, Q10 |
| H2 | Nightly + event-driven recompute | MVP | Business rules |
| H3 | Reviews tied to completed transactions only | MVP | Security §4 |
| H4 | Formal dispute case object + SLA (5 business days) | MVP | FR-10.2 |
| H5 | Evidence upload + admin-only resolution | MVP | API §10 |
| H6 | Score change only post-resolution | MVP | FR-10.3 |
| H7 | Clawback via documented reversal only | MVP | Edge cases §4 |
| H8 | Full three-way reputation (seller/business/hub) tier-gated inventory | V1.x | Feature breakdown |

## I. AI / Recommendations (rule-based v1)

| # | Feature | Tier | Source |
|---|---|---|---|
| I1 | Product/location recs (affinity+proximity+time) w/ reason summary | MVP-lite→V1 | FR-9.1 |
| I2 | Pricing/bundle suggestion (advisory) | V1.x | FR-9.2 |
| I3 | Sales-coaching content library (objection-keyed) | V1.x | FR-9.3 |
| I4 | AI business dashboard (forecasts, reallocation) | V1.x | Flow 8 |
| I5 | Product-to-seller matching / Smart Event Selling / Academy | V1.x | Feature breakdown |
| I6 | ML demand prediction (Python microservice) | Future | Arch §3 |

## J. Jobs & Shelter

| # | Feature | Tier | Source |
|---|---|---|---|
| J1 | Jobs postings + ranked nearby feed | V1.x | Flow 9 |
| J2 | Apply/accept + QR/geofence check-in-out → same-day payout | V1.x | Flow 9 |
| J3 | Shelter partner org onboarding (admin-verified) | V1.x | FR-12.1 |
| J4 | Resident cosign enrollment (capped allocation) | V1.x | FR-12.2/12.4 |
| J5 | Aggregate privacy-preserving reporting | V1.x | FR-12.3 |

## K. Notifications & Messaging

| # | Feature | Tier | Source |
|---|---|---|---|
| K1 | Multi-channel delivery (socket/push/SMS/email) | MVP | Flow 12 |
| K2 | Twilio SMS bridge for 4 background-blocked interactions | MVP | Arch §12 |
| K3 | Per-category preferences; safety-critical un-mutable | MVP | Flow 12 |
| K4 | Scoped customer↔business messaging (rate-limited/moderated) | MVP | Flow 2c |
| K5 | Extend messaging to seller/Spot-Me contexts | V1.x (rec.) | Feature breakdown |

## L. Admin, Ops & Platform

| # | Feature | Tier | Source |
|---|---|---|---|
| L1 | Category/license review queue | MVP | API §14 |
| L2 | Dispute arbitration queue | MVP | API §14 |
| L3 | Account suspend / payout hold | MVP | Roles § |
| L4 | Fraud-flag review queue (ping/oversell/spotme anomalies) | MVP→V1.x | API §14, Security §4 |
| L5 | Preregistration import from marketing waitlist | MVP | Feature breakdown |
| L6 | Sponsor records + manual attribution (dashboard deferred) | MVP/V1.x | Q9 |
| L7 | Immutable audit log for money/dispute/role/score/admin events | MVP | NFR Auditability |
| L8 | Reconciliation reports (ledger vs Stripe) | MVP | Ops |

## M. Cross-Cutting / Hidden Requirements (must-build)

| # | Feature | Tier | Source (Exec §4) |
|---|---|---|---|
| M1 | Real-time location infra (WS/geofence, not polling) | MVP | Hidden req |
| M2 | Payment holds/escrow via Stripe Connect | MVP | Hidden req |
| M3 | Anti-fraud tooling for paid-ping economy | V1.x | Hidden req |
| M4 | Dispute resolution workflow as first-class object | MVP | Hidden req |
| M5 | Category compliance metadata (`requires_license`/`regulated_by`) | MVP | Rec. improvement |
| M6 | Location data retention policy (30-day purge/aggregate) | MVP | Q7 |
| M7 | Inventory chain-of-custody / bailment liability model | MVP | Hidden req, Q2 |
| M8 | Content moderation for photos/reviews/messages | V1.x | Hidden req |
| M9 | Marketplace-facilitator tax handling | MVP | Hidden req, Q3 |
| M10 | Rate limiting + idempotency + audit as platform primitives | MVP | Security |

---

## Future Roadmap (explicitly named, not scoped)
Smart AI lockers · NFC-tagged inventory · AI Vision Verification (condition/quantity/fraud) · autonomous mobile inventory trailers · AI Personal Income Coach · inventory insurance product · featured-placement ads marketplace. All sequenced by demonstrated pilot demand, not built speculatively.

## Monetization surfaces the backend must support
Consignment transaction fee (per settled sale) · premium membership tiers (lower fees) · premium AI tools · inventory insurance (future) · featured placement/ads · training certification fees · sponsor packages. The fee schedule is **admin-configurable data** (`fee_schedule`), never hard-coded, so pricing changes are config not deploys.
