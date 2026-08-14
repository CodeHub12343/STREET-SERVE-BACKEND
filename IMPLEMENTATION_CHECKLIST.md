# StreetServe — Backend Implementation Checklist

> Actionable, phase-ordered checklist derived from every planning doc in this folder. Use as the working task list; each item traces to a doc for detail.
> Companion: [BACKEND_IMPLEMENTATION_ROADMAP.md](BACKEND_IMPLEMENTATION_ROADMAP.md).

Legend: `[ ]` todo · trace links point to the authoritative doc.

---

## Phase 0 — Foundations
- [ ] Repo scaffold, TS strict, ESLint (`no-floating-promises`, import-boundary), Prettier → [PROJECT_STRUCTURE](PROJECT_STRUCTURE.md)
- [ ] `config/env.ts` Zod-validated; fail-fast at boot on missing secrets → [THIRD_PARTY_INTEGRATIONS](THIRD_PARTY_INTEGRATIONS.md) §10
- [ ] Mongo connection (replica set, pool, read/write concern) + Redis clients (cache/pubsub/bull/adapter)
- [ ] pino logger + redaction rules + correlation via AsyncLocalStorage → [LOGGING_AND_MONITORING](LOGGING_AND_MONITORING.md)
- [ ] Managed auth: JWKS verify middleware, user-sync webhook, Principal loader → [AUTHENTICATION_AND_AUTHORIZATION](AUTHENTICATION_AND_AUTHORIZATION.md)
- [ ] Three-layer RBAC (role/ownership/tier) + central permission matrix
- [ ] **Authorization test harness** ("wrong actor → 403") — merge gate → [SECURITY_GUIDELINES](SECURITY_GUIDELINES.md) §5
- [ ] Error model + envelope + final middleware + code registry → [ERROR_HANDLING_STRATEGY](ERROR_HANDLING_STRATEGY.md)
- [ ] Rate-limit middleware (Redis, tiered) + idempotency middleware
- [ ] Event bus (BullMQ + Redis Streams) + worker skeleton + scheduler → [BACKGROUND_JOBS](BACKGROUND_JOBS.md)
- [ ] `migrate-mongo` baseline: indexes + seed categories (~15–25) + cities + fee schedule → [DATABASE_SCHEMA_PLAN](DATABASE_SCHEMA_PLAN.md)
- [ ] Audit-log writer (immutable) → [LOGGING_AND_MONITORING](LOGGING_AND_MONITORING.md) §2
- [ ] `/healthz`, `/readyz`, `/metrics`; OpenAPI generation from Zod
- [ ] Docker multi-stage + docker-compose (Mongo RS + Redis + Mailhog) + CI pipeline → [DEPLOYMENT_STRATEGY](DEPLOYMENT_STRATEGY.md)

## Phase 1 — Identity, Vendors & Payments
- [ ] `identity`: additive roles, `/auth/roles`, verification tiers, tier derivation
- [ ] KYC adapter (Stripe Identity/Persona) + `/webhooks/kyc` + reference-only storage → [THIRD_PARTY_INTEGRATIONS](THIRD_PARTY_INTEGRATIONS.md) §3
- [ ] Verification portability across roles (Q10)
- [ ] `vendors`: business CRUD, category taxonomy + suggestions (admin-approved), menu items
- [ ] **License gating**: `requires_license` blocks going live without approved doc → [VALIDATION_RULES](VALIDATION_RULES.md)
- [ ] `payments` boundary: Connect onboarding, PaymentIntents, split transfers, tiered payout timing → [THIRD_PARTY_INTEGRATIONS](THIRD_PARTY_INTEGRATIONS.md) §4
- [ ] Stripe Tax; idempotency keys; immutable ledger mirror; `/webhooks/stripe` (raw body, signature, dedupe)
- [ ] Nightly reconciliation job (ledger vs Stripe) → [BACKGROUND_JOBS](BACKGROUND_JOBS.md) §4
- [ ] Fresh Connect account, accurate marketplace category (Q5) — process step, documented

## Phase 2 — Live Map & Real-Time Core
- [ ] `livemap`: live sessions, 3-state status, Redis hot mirror + throttled Mongo snapshot + TTL ping history
- [ ] `2dsphere` nearby query (radius/category/search) + geohash bucketing + location fuzzing → [DATABASE_SCHEMA_PLAN](DATABASE_SCHEMA_PLAN.md) §3
- [ ] `realtime`: Socket.IO + Redis adapter, `/live` cell rooms, handshake auth + room authz → [REALTIME_ARCHITECTURE](REALTIME_ARCHITECTURE.md)
- [ ] `queue`: wave-down request/accept/decline/expire (configurable SLA) + ETA/tracking
- [ ] Discount engine: server-timestamp positions (FR-3.2), locked discount (FR-3.3), increasing tiers + single cap validation
- [ ] Pop-Up event + delay notification; Follow + Notify-Me; proximity alerts (throttled 1/2h)
- [ ] Sweeps: wave-down-SLA, stale-session, queue-hold-expiry, proximity-eval, notify-me-fulfillment
- [ ] Standard transaction + round-up (100% to vendor) + basic reviews

## Phase 3 — Scheduling & Dashboard
- [ ] `scheduling`: availability, book/reschedule/cancel + cutoff, reminders (24h/1h), no-show → Trust input
- [ ] `orders`: direct-order lifecycle, `ready` blocked while away_closed, partial-fulfil handling
- [ ] `messaging`: scoped customer↔business threads, `/messages` namespace, rate-limit/moderation
- [ ] Vendor dashboard read models

## Phase 4 — Consignment Core
- [ ] `consignment`: hub registration, product catalog, QR checkout (condition photo, Seller Agreement clickwrap)
- [ ] **Oversell guard** (atomic conditional `$inc`) → [BACKEND_ARCHITECTURE](BACKEND_ARCHITECTURE.md) §3.1
- [ ] Real-time inventory tracking, sale logging (qr/manual + proof), return + condition assessment
- [ ] **Settlement** math + immutable rows + tiered payout via `payments`; overdue-return sweep + penalty
- [ ] `trust` v1: versioned explainable per-role formula, nightly + event recompute
- [ ] Reviews tied to completed transactions only
- [ ] `disputes`: case object + SLA + evidence upload + admin resolve + post-resolution score change + reversal clawback
- [ ] R2 storage adapter (presigned uploads) → [THIRD_PARTY_INTEGRATIONS](THIRD_PARTY_INTEGRATIONS.md) §5

## Phase 5 — Growth Mechanics
- [ ] `growth`: ping budgets, paid tips, qualifying-action gate, daily cap (10), unique-recipient constraint
- [ ] Device-fingerprint dedupe + fraud-flag queue + score-ping-fraud job
- [ ] Gifting (redemption/expiry/notice), giveaways (daily cap), Spot Me (age/tier gate, reputation consequence)
- [ ] Block Party detection sweep (geohash cluster ≥2/150m/10min) + broadcast → [BACKEND_ARCHITECTURE](BACKEND_ARCHITECTURE.md) §3.2

## Phase 6 — AI Layer v1
- [ ] `ai`: product/location recs (affinity+proximity+time) with `reason_summary`; pricing suggestion
- [ ] Sales-coaching content library (objection-keyed); basic hub dashboard reads
- [ ] Stable interface boundary for future Python/FastAPI extraction

## Phase 7 — Jobs & Shelter
- [ ] `jobs`: postings, ranked nearby feed, apply/accept, tap/QR check-in-out → same-day payout
- [ ] `shelter`: admin-verified orgs, capped cosign enrollment, aggregate reporting (privacy-preserving)
- [ ] Legal: partner + resident agreements reviewed before ship

## Phase 8 — Launch Hardening
- [ ] Load test realtime + geospatial (10k concurrent/metro); tune indexes/TTLs/sweep cadences
- [ ] Full dashboards + page/notice alerts + runbooks → [LOGGING_AND_MONITORING](LOGGING_AND_MONITORING.md) §6-7
- [ ] DLQ + on-call for financial jobs
- [ ] Pen-test: auth + payment + authorization surfaces
- [ ] Stripe live-mode sign-off after test-mode staging pass
- [ ] Staged rollout + sponsor (Wonder Ice) integration; consignment layer city-gated

---

## Definition of Done (every feature)
- [ ] Zod validation on all inputs (unknown fields rejected)
- [ ] RBAC: role + ownership + tier guards; authz test proving "wrong actor → 403"
- [ ] Money paths: integer cents, idempotency key, transaction/atomic guard, immutable audit
- [ ] Errors thrown as typed `AppError` with a registry code + correct status
- [ ] Structured logs with correlationId; audit entry for money/dispute/role/score events
- [ ] Metrics + alert wired for any SLA-bearing path
- [ ] Unit + integration tests (Mongo RS mode); OpenAPI updated
- [ ] Cursor pagination on any list endpoint
- [ ] Graceful degradation considered (what happens if Redis/Stripe/KYC is down?)

## Cross-Cutting / Compliance (must land before public pilot)
- [ ] Data-retention policy (30-day location purge) implemented + surfaced at signup (Q7)
- [ ] Seller Agreement clickwrap (bailment) at Tier 1 (FR-8.6, Q2)
- [ ] Shelter partner + resident agreements (Q4) — legal-gated
- [ ] Marketplace-facilitator tax (Stripe Tax) live (Q3)
- [ ] Fresh, accurately-categorized Stripe Connect account (Q5)
- [ ] Immutable audit trail verified for payouts/disputes/score/role changes (NFR Auditability)

## Open Items to Confirm with Client (from docs §Open Questions, carried into backend)
- [ ] Q1 launch category set + which need `requires_license` at MVP
- [ ] "Serve Near Me" = recenter only, or broadcast a service request? (Flow 2 §3)
- [ ] Customer tab-bar reconciliation (Jobs/Sell/Wallet as Profile entry points) (Flow 2e)
- [ ] Counsel sign-off on Q2 (bailment), Q3 (money transmission/tax), Q4 (shelter liability)
