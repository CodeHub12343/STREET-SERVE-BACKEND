# StreetServe — API Specification

> REST over HTTPS, JSON, `Authorization: Bearer <jwt>` on authenticated routes. Realtime (location/queue/notifications/messages) runs over Socket.IO alongside REST — see [REALTIME_ARCHITECTURE.md](REALTIME_ARCHITECTURE.md).
> This expands `docs/09-api-specification.md` with auth requirements, RBAC, request/response contracts, and validation refs. Grouped by module.
> Companion: [AUTHENTICATION_AND_AUTHORIZATION.md](AUTHENTICATION_AND_AUTHORIZATION.md), [VALIDATION_RULES.md](VALIDATION_RULES.md), [ERROR_HANDLING_STRATEGY.md](ERROR_HANDLING_STRATEGY.md).

---

## 0. Conventions

- **Base:** `/api/v1`. Version in the path; breaking changes bump the version.
- **Auth column:** 🔓 public · 👤Role (requires that role) · 🔒 any authenticated user · 🛡️ admin.
- **Envelopes:**
  - Success: `{ "data": <payload>, "meta": { ...pagination? } }`
  - Error: `{ "error": { "code": "STRING_CODE", "message": "...", "details": {...} } }`
- **Status codes:** 400 validation · 401 unauthenticated · 403 unauthorized-for-role · 404 not found · 409 conflict (oversell/state) · 422 business-rule · 429 rate-limited · 500 unexpected.
- **Money:** integer cents everywhere. **Pagination:** cursor-based (`?cursor=&limit=`). **Idempotency:** `Idempotency-Key` header required on payment-mutating POSTs (💳 marked).
- **OpenAPI 3.1** generated from Zod schemas, served at `/docs` in non-prod.

---

## 1. Auth & Verification  `/auth`, `/verification`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/register` | 🔓 | Create account (email/phone) → OTP |
| POST | `/auth/verify-otp` | 🔓 | Confirm OTP → access + refresh token |
| POST | `/auth/login` | 🔓 | Password or passwordless (magic link/OTP) |
| POST | `/auth/refresh` | 🔓* | Rotate refresh → new access token |
| POST | `/auth/logout` | 🔒 | Revoke refresh token |
| POST | `/auth/roles` | 🔒 | Add a role to the account (additive model) |
| POST | `/verification/id-document` | 🔒 | Start KYC ID (proxies to provider) |
| POST | `/verification/selfie-liveness` | 🔒 | Start liveness check |
| POST | `/verification/bank-account` | 🔒 | Link payout account (Stripe Connect onboarding link) |
| GET | `/verification/status` | 🔒 | Current tier + pending requirements |

> Managed auth (Clerk/Auth0) may own register/login/OTP directly; these routes then thin-proxy or are replaced by provider-hosted flows + our `/auth/roles` and verification endpoints. See [AUTHENTICATION_AND_AUTHORIZATION.md](AUTHENTICATION_AND_AUTHORIZATION.md).

**Example — `POST /auth/verify-otp`**
```jsonc
// req
{ "channel":"phone", "identifier":"+14155550123", "code":"482913" }
// 200
{ "data": { "accessToken":"...", "refreshToken":"...", "user": { "id":"...", "roles":["customer"], "verificationTier":"tier0" } } }
```

## 2. Users & Profiles  `/users`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/users/me` | 🔒 | Profile + roles + tier |
| PATCH | `/users/me` | 🔒 | Update name/photo/home-area/location-precision |
| GET | `/users/:id/public-profile` | 🔓 | Public profile (reviews, trust summary) |
| GET | `/users/me/notification-preferences` | 🔒 | Read prefs |
| PATCH | `/users/me/notification-preferences` | 🔒 | Update (safety-critical categories un-mutable) |

## 3. Live Map & Location  `/live-sessions`, `/map`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/live-sessions/start` | 👤vendor/seller | Go live (creates session, opens socket channel). Blocked if `requires_license` unmet → `422 LICENSE_REQUIRED` |
| PATCH | `/live-sessions/:id/location` | 👤owner | Location tick (also mirrored via socket) |
| PATCH | `/live-sessions/:id/status` | 👤owner | Set driving/parked/away_closed |
| POST | `/live-sessions/:id/pop-up` | 👤owner | Trigger Pop-Up delay notification |
| POST | `/live-sessions/:id/stop` | 👤owner | Go offline |
| GET | `/map/nearby` | 🔓 | Pins within radius; `?lat&lng&radius&category&search&cursor&limit` |
| GET | `/map/hubs` | 🔓 | **C-1/C-2** Consignment hubs in a bbox with live availability counts; `?swLng&swLat&neLng&neLat&category&limit`. A category filter DROPS hubs with nothing matching |
| GET | `/map/demand` | 👤🔒 | **C-3** Aggregate demand tiles from wave-downs + queue joins. Floored at `DEMAND_MIN_TILE_WEIGHT`; never returns an actor id |

> High-frequency location ticks should prefer the socket path; the REST PATCH exists as a fallback and for durable snapshots.

> **Phase C bbox queries.** `/map/hubs` and `/map/demand` take a bounding box rather than
> centre+radius: these layers fill the visible map, and a radius covering a landscape viewport's
> corners over-fetches badly. An inverted box (`neLat <= swLat`) is rejected with `400` rather than
> returning an empty layer. A viewport straddling the antimeridian (`neLng < swLng`) is handled by
> splitting the query into its two real halves.

## 4. Wave Down & Queue  `/wave-downs`, `/queues`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/wave-downs` | 👤customer | Create request (server-timestamped) |
| POST | `/wave-downs/:id/accept` | 👤owner | Accept → ETA + tracking |
| POST | `/wave-downs/:id/decline` | 👤owner | Decline (reason optional) |
| GET | `/queues/:ownerId` | 🔓 | Queue state + discount schedule |
| POST | `/queues/:ownerId/join` | 👤customer | Join (server timestamps position) |
| DELETE | `/queues/:ownerId/leave` | 👤customer | Leave/cancel spot |

## 4a. Follow, Notify, Messaging  `/businesses`, `/message-threads`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST/DELETE | `/businesses/:id/follow` | 👤customer | Follow/unfollow (Favorites + status alerts) |
| GET | `/users/me/favorites` | 👤customer | Followed businesses + current status |
| POST | `/businesses/:id/notify-me` | 👤customer | One-off next-time-nearby alert |
| POST | `/message-threads` | 👤customer | Start scoped thread with a business |
| GET | `/message-threads/mine` | 🔒 | List threads (either side) |
| GET | `/message-threads/:id/messages` | 👤participant | Thread history (cursor) |
| POST | `/message-threads/:id/messages` | 👤participant | Send (rate-limited/moderated) |

## 4b. Menu & Orders  `/businesses/:id/menu`, `/orders`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/businesses/:id/menu` | 🔓 | Public menu (+ Today's Special) |
| POST | `/businesses/:id/menu` | 👤owner | Add item |
| PATCH | `/businesses/:id/menu/:itemId` | 👤owner | Update price/availability/special |
| POST 💳 | `/orders` | 👤customer | Place order (pickup-now or `bookingId`) |
| GET | `/orders/mine` | 👤customer | Order history |
| GET | `/businesses/:id/orders` | 👤owner | Vendor order queue |
| POST | `/orders/:id/accept` | 👤owner | Accept |
| POST | `/orders/:id/ready` | 👤owner | Mark ready (blocked if away_closed) |
| POST | `/orders/:id/cancel` | 👤participant | Cancel (reason required) |

## 5. Transactions, Gifting, Spot Me, Round-Up  `/transactions`, `/gifts`, `/spot-me`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST 💳 | `/transactions` | 👤customer | Create (applies locked discount server-side) |
| POST 💳 | `/transactions/:id/round-up` | 👤customer | Add round-up tip (100% to vendor) |
| POST 💳 | `/gifts` | 👤customer | Create gift + redemption code |
| POST | `/gifts/:code/redeem` | 👤🔓 | Redeem |
| POST | `/giveaways/:id/claim` | 👤customer | Claim free unit (daily cap) |
| POST | `/spot-me` | 👤customer | Request (blocked <30d / <bronze → 422) |
| POST | `/spot-me/:id/decide` | 👤counterparty | Accept/decline |
| POST | `/spot-me/:id/repay` | 👤🔓 | Mark repaid |

## 5a. Payouts & Seller Balance  `/payments`, `/debts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/payments/connect/onboard` | 👤🔒 | Start Stripe Connect onboarding |
| GET | `/payments/connect/status` | 👤🔒 | Connect account + balance |
| GET | `/payments/funds-availability` | 👤🔒 | **A-2** Why money is held — per-reason buckets (tier hold, uncollected cash, missing account, unsettled stock), each with its cause and remedy, plus the single most useful next step |
| GET | `/debts/mine` | 👤🔒 | Outstanding cash-sale balances |
| GET | `/debts/credit` | 👤🔒 | Inventory + debt ceilings. **A-3** scaled by Trust band; reports `tierMaxInventoryValueCents` alongside the scaled `maxInventoryValueCents` |
| POST 💳 | `/debts/:id/repay` | 👤🔒 | Clear a balance by card |

## 6. Scheduling  `/bookings`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/businesses/:id/availability` | 🔓 | Open slots |
| POST 💳 | `/bookings` | 👤customer | Create booking |
| PATCH | `/bookings/:id` | 👤participant | Reschedule (cutoff-checked) |
| DELETE | `/bookings/:id` | 👤participant | Cancel |

## 7. Ping Sharing  `/ping-budgets`, `/pings`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST 💳 | `/ping-budgets/:businessId` | 👤owner | Fund/reload budget |
| PATCH | `/ping-budgets/:businessId` | 👤owner | Pause/resume, adjust tip |
| POST | `/pings` | 👤🔒 | Log a forward/share (rate-capped) |
| GET | `/pings/mine` | 👤🔒 | Ping history + earned tips |

## 8. Consignment — Hubs & Products  `/hubs`, `/products`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/hubs` | 👤vendor | Register business as hub (`citySlug` sets the tax + permit jurisdiction — **A-6**) |
| POST | `/hubs/:id/products` | 👤owner | List a product. **A-1** non-`consignment` `listingType` → 422 `LISTING_TYPE_UNSUPPORTED`. **A-6** food categories → 403 `CATEGORY_NOT_PERMITTED` unless the hub city is cleared. **A-3** `minSellerTrustScore` gates it to trusted sellers |
| PATCH | `/hubs/:id/products/:productId` | 👤owner | Update terms/quantity |
| GET | `/products/nearby` | 👤seller | Discovery feed (`?lat&lng&radius&category`) |
| GET | `/hubs/:id/inventory-map` | 👤hub owner | **C-5** Sellers holding this hub's stock, with live coordinates. Holders with no session are returned WITHOUT coordinates rather than omitted |

## 9. Consignment — Seller Lifecycle  `/checkouts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST 💳 | `/checkouts` | 👤seller | Reserve + QR check-out (condition photo; requires Seller Agreement) |
| GET | `/checkouts/mine` | 👤seller | Active/past checkouts |
| POST 💳 | `/checkouts/:id/sales` | 👤seller | Log sale (oversell-guarded → 409) |
| POST | `/checkouts/:id/return` | 👤seller | QR check-in unsold |
| GET | `/checkouts/:id/settlement` | 👤participant | Settlement breakdown |

## 10. Trust, Reviews, Disputes  `/trust-scores`, `/reviews`, `/disputes`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/trust-scores/:subjectType/:subjectId` | 🔓 | Score + formula version |
| GET | `/trust-scores/me/benefits` | 👤🔒 | **A-3** Own band + what it unlocks (inventory multiplier, fee discount, premium eligibility) and how far the next band is |
| POST | `/reviews` | 👤customer | Review tied to a completed transaction |
| POST | `/disputes` | 👤🔒 | Open dispute (checkout/transaction/spot-me) |
| GET | `/disputes/:id` | 👤participant | Case status |
| POST | `/disputes/:id/evidence` | 👤participant | Upload evidence |
| POST | `/disputes/:id/resolve` | 🛡️ | Admin resolution (triggers post-resolution score change) |

## 11. Jobs  `/jobs`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/jobs/nearby` | 👤🔒 | Ranked nearby gigs. **A-5** `?jobType=` narrows by work type (repeatable or comma-separated) |
| GET | `/jobs/types` | 🔓 | **A-5** Filter vocabulary (`sell`, `signage`, `delivery`, `sampling`, `promotion`, `event_staffing`) |
| POST | `/jobs` | 👤vendor/🛡️ | Post a gig |
| POST | `/jobs/:id/apply` | 👤🔒 | Apply/accept |
| POST | `/jobs/:id/check-in` | 👤applicant | Geofence **or** QR check-in (`lat`+`lng` or `qrToken`) |
| POST 💳 | `/jobs/:id/check-out` | 👤applicant | Complete → payout |
| GET | `/jobs/mine` | 👤🔒 | Gigs the caller applied to |
| GET | `/jobs/posted` | 👤vendor/hub/🛡️ | Gigs the caller posted, with applicant counts |
| GET | `/jobs/:id/applicants` | 👤poster | Who claimed this gig |
| GET | `/jobs/:id/qr` | 👤poster | Rotating on-site check-in code (30s window) |
| POST | `/jobs/:id/no-show` | 👤poster | Record a no-show; reopens the posting |
| POST | `/jobs/:id/cancel` | 👤poster | Cancel the gig |

## 12. Shelter Partner Program  `/shelter-partners`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/shelter-partners` | 🛡️ | Register org (admin-approved) |
| POST | `/shelter-partners/:id/enrollments` | 👤shelter_admin | Cosign resident enrollment (capped). **B-1** `residentUserId` is now OPTIONAL — omit it and the response carries a one-time `claimCode` |
| PATCH | `/shelter-partners/:id/custody` | 👤shelter_admin | **B-3** Accept/decline the custody duty + collection instructions |
| GET | `/shelter-partners/:id/custody` | 👤shelter_admin | **B-3** What the org is holding for residents (`?status=held`) |
| POST | `/shelter-partners/:id/custody/:custodyId/disburse` | 👤shelter_admin | **B-3** Record cash/in-kind handover |
| POST | `/shelter-partners/:id/enrollments/exit` | 👤shelter_admin | Close an enrollment; held custody stays the resident's |
| GET | `/shelter-partners/:id/reporting` | 👤shelter_admin | Aggregate, privacy-preserving report |

### 12a. Resident-facing  `/residents`

Mounted separately: **none of these require `shelter_admin`**. A resident must never need staff
permissions to see their own money.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/residents/claim` | 👤🔒 | **B-1** Redeem a staff-issued code → becomes a seller at Bronze, no ID or bank account |
| GET | `/residents/me` | 👤🔒 | **B-2** Capability matrix (cosign remaining, training, grant, custody). `null` if not a resident |
| GET | `/residents/training/course` | 👤🔒 | **B-5** Starter course — never includes answer keys |
| GET | `/residents/training/status` | 👤🔒 | **B-5** Pass state + best score |
| POST | `/residents/training/submit` | 👤🔒 | **B-5** Grade; returns an explanation for EVERY question |
| GET | `/residents/custody` | 👤🔒 | **B-3** What's waiting and where to collect it |
| POST | `/residents/custody/:id/acknowledge` | 👤🔒 | **B-3** Confirm receipt |

## 12b. Academy, Seller Profile & Earn Hub  `/academy`, `/sellers`, `/earn`  (Phase D)

The Academy writes the SAME `training_completions` table as B-5's resident course — that table was
named generically on purpose, so the resident curriculum is course #1 here rather than a special case.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/academy/courses` | 👤🔒 | **D-3** Catalog with the caller's own progress, prerequisites and retake state |
| GET | `/academy/courses/:slug` | 👤🔒 | **D-3** One course, ready to take. Never includes answer keys |
| POST | `/academy/courses/:slug/submit` | 👤🔒 | **D-3** Grade. Records the attempt either way; returns an explanation for EVERY question |
| GET | `/academy/me/credentials` | 👤🔒 | **D-4** Badges + certifications, DERIVED from completions (no second table) |
| GET | `/sellers/me/profile` | 👤🔒 | **D-2** Self-declared + inferred matching signals, kept in separate fields |
| PATCH | `/sellers/me/profile` | 👤🔒 | **D-2** Update the self-declared half only — inferred fields are conclusions, not inputs |
| GET | `/sellers/profile-options` | 👤🔒 | **D-2** The closed vocabulary (skills / venues / transport) |
| GET | `/earn` | 👤🔒 | **D-1** Every way to earn today, ranked on payout AND time-to-payout; `?lat&lng&limit` |

> **D-5.** `POST /hubs/:id/products` accepts `requiredCertification`. A seller without it gets
> `403 CERTIFICATION_REQUIRED`, and the message names the course and its length — unlike a Trust
> shortfall, a certification lock is clearable the same day.

> **D-1 honesty note.** A consignment opportunity quotes what the seller keeps on ONE unit, net of
> the platform fee — never the value of the whole pickup.

## 12c. Events  `/events`  (Phase E)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/events/nearby` | 🔓 | **E-4** Events near a point; `?lat&lng&radiusM&withinHours`. `expectedAttendance` is NULLABLE — unknown is a real state, never 0 |
| POST | `/events` | 🛡️ `admin:manage_events` | **E-4** Manual entry — the pilot's PRIMARY source. Marked `verified` |
| POST | `/events/:id/cancel` | 🛡️ `admin:manage_events` | Withdraw an event |

> Its own permission rather than `manage_categories`: an event drives seller ALERTS, so a bad entry
> notifies every seller near a venue — a different blast radius from a taxonomy edit.

## 13. AI / Recommendations  `/ai`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/ai/recommendations/products` | 👤seller | Product suggestions + reason summary |
| GET | `/ai/recommendations/locations` | 👤seller | Location suggestions |
| GET | `/ai/pricing-suggestion` | 👤seller/hub | Suggested price/bundle |
| POST | `/ai/sales-coaching` | 👤seller | Objection type → scripted response |
| POST | `/ai/coach/plan` | 👤seller | **E-9** Income Coach: goal → basket + locations. May return `achievable: false` |
| GET | `/ai/outcomes/stats` | 🛡️ `admin:read_overview` | **E-1** Dataset health — gates whether `AI_PROVIDER=forecast` is worth switching on |
| GET | `/ai/hubs/:id/reallocation` | 👤hub owner | **E-10** Categories selling better in other tiles |

> **What the engine actually is.** `AI_PROVIDER` selects `rule_based` | `gemini` | `forecast`.
> `forecast` (E-6) is a **statistical** demand forecaster over `outcome_facts`, adjusted by weather,
> calendar and events — *not* a trained model. Every recommendation decomposes into named factors.
> The `RecommendationEngine` interface is the seam a real model would slot into later.

> **E-9 may say no.** A plan is allowed to fall short of the goal (`achievable: false`, with
> `advice[]`), and goals over $1,000/day are refused with `422`. Clients must render the shortfall
> rather than rounding it away — see `incomeCoach` for why.

## 13b. Monetization  `/subscriptions`, `/placements`  (Phase F)

Six plans. Four sell to a **business**; `seller_plus` and `stock_waiver` are the first two that sell
to an individual **seller** — the platform's largest population, which previously had nothing to buy.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/subscriptions/plans` | 🔓 | All six plans with prices and scope (`user` \| `business`) |
| GET | `/subscriptions/mine` | 👤 `subscription:read` | Entitlements; `?businessId` resolves the business-scoped four |
| POST | `/subscriptions` | 👤 `subscription:manage` | Subscribe. Idempotent |
| POST | `/subscriptions/:plan/cancel` | 👤 `subscription:manage` | Cancel immediately |
| GET | `/subscriptions/waiver/status` | 👤🔒 | **F-4** Live cover: caps, remaining this period, or why it hasn't started |
| GET | `/subscriptions/waiver/history` | 👤🔒 | **F-4** Every write-off applied, with the amount absorbed |
| POST | `/placements/featured` | 👤🔒 | **F-1** Buy a featured slot for a product or hub you own |
| POST | `/placements/campaigns` | 👤🔒 | **F-3** Create a CPM campaign; budget is prepaid and spent down |
| GET | `/placements/mine` | 👤🔒 | Own placements with real delivery numbers; `?businessId` |
| POST | `/placements/:id/pause` | 👤owner | Pause/resume |
| GET | `/placements/serve` | 🔓 | **F-1/F-3** Ads for a surface; `?placement&citySlug&category&lng&lat&feedSize` |
| POST | `/placements/:id/click` | 🔓 | Record a click |
| POST | `/academy/courses/:slug/purchase` | 👤🔒 | **F-5** Buy a paid certification. `422 PAYMENT_REQUIRED` from `/submit` until then |

> **F-1/F-3 disclosure.** Every served item carries `label: "Promoted"` and the client MUST render
> it. Featured placement is **additive** — a boost on top of the organic score, never a replacement
> for it, so a paid slot can't outrank a genuinely better result by an unbounded margin. Ads are
> capped at `AD_MAX_SHARE_OF_FEED` (20%) of any feed.

> **F-2 whose money.** The Seller Plus fee discount (15%) comes out of the platform's cut. The hub's
> share of a settlement is untouched — the same rule as the A-3 trust-band discount.

> **F-4 is a waiver, not insurance.** ⚠️ It waives the platform's right to recover what a seller
> would owe on lost or damaged stock. It **never pays money to a seller** and covers nothing beyond
> that debt. The words *insurance, insured, policy, premium, claim* must not appear in any
> user-facing copy — not even in a negation, which still names the association. Charging a price and
> paying claims is what makes a platform an insurer, requiring a licensed carrier and state-by-state
> licensing. Tests in `test/phaseF.test.ts` and the frontend's `phaseF-render.test.tsx` enforce this.

> **F-5 material stays free.** Purchase gates the *certification exam*, not the lessons. Anyone can
> read every course; only the credential costs money.

## 14. Admin / Platform Ops  `/admin`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/admin/categories` | 🛡️ | Manage taxonomy + license metadata |
| POST | `/admin/category-suggestions/:id/review` | 🛡️ | Approve/reject (sets license metadata) |
| POST | `/admin/license-documents/:docId/review` | 🛡️ | Approve/reject license proof |
| GET | `/admin/disputes` | 🛡️ | Full dispute queue |
| POST | `/admin/users/:id/suspend` | 🛡️ | Suspend account |
| GET | `/admin/fraud-flags` | 🛡️ | Ping/oversell/spot-me anomalies |
| POST | `/admin/payouts/:id/hold` | 🛡️(finance) | Place/release payout hold |
| GET | `/admin/reconciliation` | 🛡️(finance) | Ledger vs Stripe report |
| GET/POST | `/admin/sponsors` | 🛡️ | Sponsor records + attribution |

## 15. Webhooks (no bearer auth — signature-verified, raw body)

| Method | Path | Source | Purpose |
|---|---|---|---|
| POST | `/webhooks/stripe` | Stripe | PaymentIntent, transfer, payout, tax, Connect account events |
| POST | `/webhooks/kyc` | Stripe Identity/Persona | Verification result → tier update |
| POST | `/webhooks/clerk` | Clerk/Auth0 | User lifecycle sync |

## 16. System

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness |
| GET | `/readyz` | Readiness (Mongo + Redis + Stripe reachability) |
| GET | `/metrics` | Prometheus (internal-only) |

---

## 17. Authentication Flow (detail)

1. `POST /auth/register` (email/phone) → unverified user, OTP sent (Twilio/email).
2. `POST /auth/verify-otp` → short-lived access JWT (~15 min) + rotated refresh token (httpOnly).
3. Every request carries the access token; on 401-expired, client transparently calls `/auth/refresh`.
4. Adding a role is a separate authorized call (`/auth/roles`) — no new account (additive model).
5. Verification is **async**: `/verification/id-document` returns `pending`; a provider webhook (`/webhooks/kyc`) updates status; client is notified via socket/push or polls `/verification/status`.
6. `/verification/bank-account` redirects to Stripe Connect hosted onboarding — StreetServe never handles raw bank credentials.

## 18. Cross-Cutting API Rules

- Every list endpoint is cursor-paginated; unbounded scans are rejected.
- `Idempotency-Key` required on 💳 routes; a repeated key returns the cached first response.
- All monetary values integer cents; all timestamps ISO-8601 UTC.
- RBAC + resource-ownership enforced server-side on every non-public route — never trust a client-declared role.
- Rate limits are tighter on money-movement and sharing endpoints than on read-only map queries (see [SECURITY_GUIDELINES.md](SECURITY_GUIDELINES.md)).
