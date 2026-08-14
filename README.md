# StreetServe — Backend

> 📑 **[DOCS_INDEX.md](DOCS_INDEX.md) labels every document in this repo current / historical.**
> Start there if you are looking for something. The active plan lives in the frontend repo:
> `../STREET-SERVE-APPLICATION/audit/2026-08-marketplace-spec/IMPLEMENTATION_ROADMAP.md`.


The complete backend implementation blueprint for StreetServe, derived from the product/engineering docs in `../STREET-SERVE-APPLICATION/docs`. **No production code** — this is the single source of truth to build against.

## Stack (confirmed for this project)
Node.js · Express · TypeScript (strict) · **MongoDB** (Atlas, replica set) · Mongoose · Redis · Socket.IO (+ Redis adapter) · BullMQ · Clerk/Auth0 (auth) · Stripe Identity/Persona (KYC) · **Stripe Connect + Stripe Tax** (money) · Cloudflare R2 · Twilio · FCM · Postmark.

> **Database note:** the product docs recommend PostgreSQL+PostGIS but explicitly accept full MongoDB as a valid MERN-native path. This blueprint takes the MongoDB path per the project brief, and addresses head-on the two workloads the docs warn Mongo makes us engineer: **financial/settlement integrity** (multi-document transactions + atomic conditional guards + immutable rows + reconciliation) and **Block Party geo detection** (application-level geohash sweep). See [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md) §3.

## Implementation status

**Phase 0 — Foundations: implemented.** A runnable Node + Express + TypeScript + MongoDB service lives alongside these docs (`src/`, `test/`, `migrations/`). It delivers the Phase 0 exit criterion — *an authenticated request flows end-to-end with RBAC, validation, logging, and a passing authz test* — plus JWKS auth, the three-layer permission matrix, error/idempotency/rate-limit middleware, the BullMQ event bus + worker, Socket.IO + Redis adapter, health/metrics/OpenAPI, and migration-seeded reference data.

### Getting started
```bash
cp .env.example .env            # fill in AUTH_* for a real Clerk/Auth0 tenant
docker compose up -d            # Mongo (replica set) + Redis + Mailhog
npm install
npm run migrate:up              # indexes + seed categories/city/fee schedule
npm run dev                     # API + Socket.IO on :8080
npm run dev:worker              # BullMQ worker (separate process)
```

### Verify
```bash
npm run typecheck && npm run lint && npm test   # tests boot an in-memory Mongo replica set
curl localhost:8080/healthz                     # liveness
curl localhost:8080/openapi.json                # generated API doc (non-prod)
```

### What's wired
- **Auth:** managed-provider JWT verified via JWKS at the edge; Principal (roles from DB, not the token); JIT provisioning; signed user-sync webhook.
- **Authz:** central permission matrix + `requirePermission(action, ownershipResolver)` (role → tier → ownership); suspension interlock; separation of duties (admin ≠ finance).
- **Platform:** Zod validation, standard error envelope + code registry, correlation IDs (AsyncLocalStorage), Redis-backed rate limiting + idempotency (in-memory fallback), append-only audit log, cursor pagination.
- **Async/realtime:** BullMQ queues + scheduler + worker, event bus, Socket.IO `/notifications` namespace with handshake auth.
- **Ops:** `/healthz` `/readyz` `/metrics` (Prometheus), OpenAPI 3.1 from Zod, Dockerfile + docker-compose, GitHub Actions CI (typecheck, lint, test, build, `npm audit`).

**Phase 1 — Identity, Vendors & Payments: implemented.** The transactional spine is live:
- **KYC verification** — `identity`/`verification` module + Stripe Identity/Persona adapter (`integrations/kyc`), hosted-flow sessions, async webhook resolution, tier upgrades (Bronze/Silver), portable across roles. Reference-only storage (no raw documents).
- **Payments boundary** — `payments` module over **Stripe Connect** (`integrations/stripe`, injectable/mockable): connected-account onboarding, **destination charges with an application fee (split payout)**, tiered payout schedules (FR-11.2), an immutable transaction ledger mirror, idempotency, refunds, signed **Stripe webhook** ingestion, and a **nightly reconciliation** job (ledger vs Stripe).
- **Vendors** — `vendors` module: business CRUD (owner-scoped), menus + Today's Special, hub flag, admin-reviewed **category suggestions**, and **license gating** (`canGoLive` blocked for regulated categories until an approved license document exists).

Phase 1 exit criteria met and tested: *a customer can be charged, a connected account receives a split payout, reconciliation runs clean* — plus the verification lifecycle, license gating, and vendor ownership. **29/29 tests pass.**

**Phase 2 — Live Map & Vendor Real-Time Core: implemented.** The realtime spine is live:
- **livemap** — `live_sessions` (3-state driving/parked/away_closed), 2dsphere `/map/nearby` with category/search filters + seller location fuzzing, a Redis hot mirror (KV abstraction) + geohash cells, TTL'd `location_pings`, follow/notify-me + favorites, and go-live **license gating**.
- **realtime** — Socket.IO `/live` (geohash-cell rooms) + `/queue` namespaces with handshake auth; an injectable `realtime` hub so services broadcast without coupling to sockets (and tests capture emits).
- **queue** — wave-down (server-timestamped, SLA-expiring, auto-join on accept), the **line-up discount engine** (server-timestamp positions, discount **locked at join**, strictly-increasing tiers + cap validation), Pop-Up delay, and **checkout that charges the locked discount** via Stripe Connect.
- **reviews** — one per completed transaction (anti-manipulation).
- **Sweeps** — wave-down-SLA, stale-session, queue-hold-expiry, proximity-alert-eval (BullMQ repeatable jobs).

Phase 2 exit criteria met and tested: *a vendor goes live, a customer sees the pin via /map/nearby, waves down, joins the queue at the correct server-timestamped tier, and pays the locked discount.* **37/37 tests pass.**

**Phase 3 — Scheduling & Vendor Dashboard: implemented.**
- **scheduling** — bookable `services` + weekly `availability_windows`, slot-computed availability, book/reschedule/cancel with cutoff, **24h + 1h reminders** (sweep), and **no-show → Trust input** event.
- **orders** — direct-order lifecycle (place → accept → ready → complete/cancel), the **away_closed interlock** (no ordering when closed, no "ready" while Away), server-computed totals + charge on placement, and **partial fulfilment** (remove an out-of-stock line + partial refund, never a silent substitution).
- **messaging** — scoped, rate-limited customer↔business threads (participant-enforced), realtime `/messages` delivery.
- **dashboard** — a composite vendor read model (live status, queue, order queue, sales log, threads) for the owner.

Phase 3 exit criteria met and tested: *booking + direct-order flows work end-to-end with reminders and dashboard reads.* **43/43 tests pass.**

**Phase 4 — Consignment Core: implemented.** The other financial-correctness-heavy half:
- **consignment** — hub registration (QR secret), product catalog, the clickwrap **Seller Agreement** (bailment), **QR checkout** with condition photo + atomic inventory reservation, the **oversell guard** (race-safe atomic conditional `$inc`), sale logging, return + condition assessment, **settlement** (gross − platform fee − hub share = seller net, itemized, **immutable**, disbursed via **split transfers** to the seller + hub connected accounts by payout tier), and an **overdue-return sweep**.
- **trust** v1 — versioned, explainable, per-role score (`score = 100 − 25·upheldDisputeRate − 15·lateReturnRate + 10·onTimeRate + (avgReview−3)·5`); event + nightly recompute; scores are public with their inputs.
- **disputes** — first-class case object with SLA, evidence upload, admin resolution, **post-resolution-only** Trust change (FR-10.3), and clawback via documented reversal.
- **storage** — Cloudflare R2 presigned-upload adapter (injectable/mockable) for condition/evidence/product photos.

Phase 4 exit criteria met and tested: *a seller checks out, cannot oversell, sells, returns, settles with an itemized split payout, and a dispute correctly gates a Trust Score change.* **49/49 tests pass.**

**Phase 5 — Growth Mechanics: implemented.** The fraud-sensitive layer:
- **ping economy** — vendor-funded budgets, paid shares with a **qualifying-action gate** and every fraud guard: per-sender **daily cap**, **one-tip-per-recipient-per-vendor** (partial unique index), **device-fingerprint dedupe**, **self-referral** + **already-active-recipient** rejection, atomic budget debit, and a fraud-flag queue. Tips are paid only to genuinely qualifying recipients; everything else is flagged, not paid.
- **gifting** — prepaid redemption codes with expiry + pre-expiry notice; **giveaways** — atomic daily cap + one-claim-per-user-per-day.
- **Spot Me** — age (≥30d) + Bronze gate, trust-informed decisions, and a default sweep with a reputational (not debt-collection) consequence.
- **Block Party** — geohash/spatial cluster detection (≥2 vendors within 150m, sustained via Redis first-seen) + broadcast to opted-in users within ~1 mile.

Phase 5 exit criteria met and tested: *paid pings pay tips only to genuinely qualifying recipients; farming attempts are flagged, not paid.* **55/55 tests pass.**

**Phase 6 — AI Layer v1 (rule-based): implemented.**
- **`RecommendationEngine` interface** — the stable seam for the future Python/FastAPI ML service (swap via `setRecommendationEngine()`, zero consumer changes). Phase 6 ships a **`RuleBasedEngine`**.
- **Product recs** — ranked by real first-party signals (recent **sell-through** + **category affinity** + **time-of-day** + proximity when available), every score decomposed into an **explainable `reasonSummary`**; served recs are logged (`ai_recommendations`) with an accept signal.
- **Location recs** — busy hubs by recent revenue; **pricing suggestion** — median of comparable recent sales, flagged **advisory-only**; **sales coaching** — a maintained content library keyed to objection categories (not generative/live-audio); **hub dashboard** — per-product sell-through + reallocation hints.

Phase 6 exit criteria met and tested: *explainable, advisory recommendations served from real first-party signals.* **60/60 tests pass.**

**Phase 7 — Jobs & Shelter Program: implemented.**
- **jobs** — postings with a ranked nearby feed (pay-per-time + proximity, explainable), self-serve **atomic claim**, **on-site tap check-in** (proximity-validated when coords are supplied), and **check-out → same-day payout** to the worker's connected account.
- **shelter** — admin-verified partner orgs; a shelter-staff owner **cosigns a resident** into a **capped starter allocation** (the hard liability cap, FR-12.4) that grants the resident a **Tier-1-equivalent (`shelter_cosign` Bronze) verification + seller role without standard KYC** (Flow 1b); **aggregate, privacy-preserving reporting** (counts + totals only — never per-resident detail, FR-12.3).

Phase 7 exit criteria met and tested (gig lifecycle end-to-end with payout; shelter verify→cosign→aggregate report). **64/64 tests pass.**

**Phase 8 — Launch Hardening: implemented.**
- **Observability** — business/SLA Prometheus metrics (oversell rejects, settlement latency, payout success, reconciliation drift, dispute outcomes, fraud flags, ping tips, block-party, live-session staleness, dead-lettered financial jobs) on `/metrics`.
- **Financial resilience** — conservative retry + a **dead-letter queue** for financial jobs, with an on-call metric + fatal log on final failure.
- **Launch scoping** — public `/config/launch` + **city-scoped feature flags** (`requireFeature`) gating the consignment layer to launch cities (expansion is a config change).
- **Sponsors (Wonder Ice)** — admin CRUD, public logo list, **UTM attribution** on pre-registration, impression tracking, manual reporting.
- **Security hardening** — locked CSP (`default-src 'none'`), HSTS, `no-referrer`, no-sniff, framework hidden.
- **Runbooks** ([RUNBOOKS.md](RUNBOOKS.md)) for every page-level alert + a **pre-launch checklist**; **load-test harnesses** (`scripts/loadtest-http.mjs`, `scripts/loadtest-socket.mjs`).

Phase 8 exit is **operational, not just code** — the remaining pre-pilot items (run the load tests at scale, wire dashboards/alerts to a provider, pen-test, Stripe live-mode sign-off, real-credential smoke tests for Stripe/KYC/R2, staged rollout) are enumerated in [RUNBOOKS.md](RUNBOOKS.md) → *Pre-launch checklist*. **69/69 tests pass.**

**The StreetServe backend is now built end-to-end across Phases 0–8** — every product feature plus launch hardening — **10 test suites, 69 tests, all green.**

## Read in this order
1. [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md) — style, systems of record, the two "Mongo bites," cross-cutting concerns
2. [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) — folders, layering, conventions, tooling
3. [MODULE_BREAKDOWN.md](MODULE_BREAKDOWN.md) — every module, responsibilities, events, dependencies
4. [BACKEND_FEATURE_INVENTORY.md](BACKEND_FEATURE_INVENTORY.md) — full feature inventory, MVP/V1.x/Future
5. [DATABASE_SCHEMA_PLAN.md](DATABASE_SCHEMA_PLAN.md) — collections, documents, indexes (MongoDB)
6. [VALIDATION_RULES.md](VALIDATION_RULES.md) — Zod edge + service-layer invariants + state machines
7. [API_SPECIFICATION.md](API_SPECIFICATION.md) — every endpoint, auth, RBAC, contracts
8. [AUTHENTICATION_AND_AUTHORIZATION.md](AUTHENTICATION_AND_AUTHORIZATION.md) — identity, 9-role additive model, tiers, 3-layer authz
9. [REALTIME_ARCHITECTURE.md](REALTIME_ARCHITECTURE.md) — Socket.IO namespaces, geohash rooms, hot path
10. [BACKGROUND_JOBS.md](BACKGROUND_JOBS.md) — BullMQ queues, event-triggered + scheduled jobs, retry policy
11. [THIRD_PARTY_INTEGRATIONS.md](THIRD_PARTY_INTEGRATIONS.md) — adapters, webhooks, failure handling
12. [SECURITY_GUIDELINES.md](SECURITY_GUIDELINES.md) — data protection, fraud, OWASP, scalability, risk register
13. [ERROR_HANDLING_STRATEGY.md](ERROR_HANDLING_STRATEGY.md) — envelope, AppError, code registry, status mapping
14. [LOGGING_AND_MONITORING.md](LOGGING_AND_MONITORING.md) — logs, audit trail, metrics, alerts, dashboards
15. [DEPLOYMENT_STRATEGY.md](DEPLOYMENT_STRATEGY.md) — envs, containers, CI/CD, migrations, launch readiness
16. [BACKEND_IMPLEMENTATION_ROADMAP.md](BACKEND_IMPLEMENTATION_ROADMAP.md) — phased build order + dependencies + complexity
17. [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md) — actionable, phase-ordered checklist + DoD

## Non-negotiables carried from the product docs
- **Stripe Connect** for all money movement — never a custom ledger. Fresh account, accurate marketplace category (Q5).
- **Socket.IO + Redis adapter** from day one (multi-instance correctness).
- **Twilio SMS bridge** for the four background-blocked interactions the PWA can't do while the phone sleeps.
- **Tiered verification is a security control**, not just UX — three-layer authz + mandatory authorization tests.
- Integer cents everywhere · immutable financial + audit records · 30-day location retention.
