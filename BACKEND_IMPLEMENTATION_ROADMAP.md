# StreetServe — Backend Implementation Roadmap

> Phased backend build order, milestones, dependencies, and complexity — the sequence in which to actually write the code, aligned to the product roadmap (`docs/11`) but backend-scoped.
> Companion: [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md), [MODULE_BREAKDOWN.md](MODULE_BREAKDOWN.md), [BACKEND_FEATURE_INVENTORY.md](BACKEND_FEATURE_INVENTORY.md).

Build order is driven by **dependency direction** (foundations first) and **risk-front-loading** (the real-time core and financial correctness are the hardest; sequence them where they get the most iteration time). Complexity: 🟢 low · 🟡 medium · 🔴 high.

---

## Phase 0 — Foundations 🟡  (Product Milestone 0)
*No user-facing features. Wrong choices here are expensive to unwind.*

- Repo scaffold, TypeScript strict, ESLint/Prettier, folder structure ([PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)).
- `config/env.ts` (Zod-validated), Mongo connection (replica set), Redis clients, pino logger.
- Docker + docker-compose (Mongo replica set + Redis + Mailhog), CI pipeline, dev/staging/prod envs.
- Managed auth integration (Clerk/Auth0): JWKS verification middleware, user sync webhook, Principal loader.
- **Three-layer RBAC** (role/ownership/tier) + central permission matrix + the authorization test harness (built now, used forever).
- Error model + envelope + middleware; request-context/correlation; rate-limit + idempotency middleware.
- Event bus (BullMQ + Redis Streams) + BullMQ worker skeleton + scheduler.
- `migrate-mongo` baseline: core indexes, **seed the curated category taxonomy (~15–25), cities, fee schedule**.
- Audit-log writer; health/readiness/metrics endpoints; OpenAPI generation.
- **Dependencies:** none. **Exit:** an authenticated request flows end-to-end with RBAC, validation, logging, and a passing authz test.

## Phase 1 — Identity, Vendors & Payments Core 🔴
*The shared spine every transactional feature needs.*

- `identity`: additive roles, verification tiers, KYC adapter (Stripe Identity/Persona) + webhook, verification portability.
- `vendors`: business CRUD, category taxonomy + suggestions, **license gating**, menu items, hub flag.
- `payments` boundary: Stripe Connect onboarding, PaymentIntents, split transfers, tiered payout timing, Stripe Tax, idempotency, immutable ledger mirror, Stripe webhook ingestion + nightly reconciliation.
- **Dependencies:** Phase 0. **Complexity:** 🔴 (financial correctness + KYC async lifecycle). **Exit:** a customer can be charged, a connected account can receive a split payout in test mode, reconciliation runs clean.

## Phase 2 — Live Map & Vendor Real-Time Core 🔴  (Product Milestone 1)
*The realtime spine the rest of the product depends on.*

- `livemap`: live sessions, 3-state status, Redis hot mirror + throttled Mongo snapshot + TTL ping history, `2dsphere` nearby query, geohash bucketing, location fuzzing/precision.
- `realtime`: Socket.IO + Redis adapter, `/live` namespace, geohash-cell rooms, handshake auth + room authz.
- `queue`: wave-down (request/accept/decline/expire SLA), line-up discount engine (server-timestamp positions, locked discount, cap validation), Pop-Up event + delay notification.
- Follow / Notify-Me; proximity alerts (throttled) via sweep + notifications.
- Standard transaction + round-up (Stripe Connect standard checkout, no consignment yet); basic reviews.
- Sweeps: wave-down-SLA, stale-session, queue-hold-expiry, proximity-alert-eval.
- **Dependencies:** Phases 0–1. **Complexity:** 🔴 (this is the hot path; load-shape it early). **Exit:** a vendor goes live, a customer sees the pin <3s, waves down, joins the queue at the correct server-timestamped tier, and pays with the locked discount.

## Phase 3 — Scheduling & Vendor Dashboard 🟡  (Product Milestone 2)
- `scheduling`: availability, book/reschedule/cancel with cutoff, reminders (24h/1h), no-show → Trust input.
- `orders`: direct-order lifecycle, away_closed interlock, partial-fulfil handling.
- Vendor dashboard read models (live toggle, queue view, order queue, basic sales log, incoming messages) + `messaging` module.
- **Dependencies:** Phase 2. **Complexity:** 🟡. **Exit:** booking + direct-order flows work end-to-end with reminders and dashboard reads.

## Phase 4 — Consignment Core 🔴  (Product Milestone 3)
*Financial correctness + physical chain-of-custody — the other hard half.*

- `consignment`: hub registration, product catalog, QR checkout (condition photo, Seller Agreement clickwrap), reservation, seller live pin (reuses livemap).
- **Oversell guard** (atomic conditional update), real-time inventory tracking, sale logging, return + condition assessment.
- **Settlement** math + tiered payout via `payments`, immutable settlement rows, overdue-return sweep + penalty.
- `trust` v1: versioned explainable formula, per-role scores, nightly + event recompute; reviews-tied-to-transaction.
- `disputes`: case object, SLA, evidence upload, admin resolution, post-resolution score change, clawback via reversal.
- Storage adapter (R2 presigned uploads) for condition/evidence photos.
- **Dependencies:** Phases 0–1 (auth/payments); shares livemap for seller pins. **Complexity:** 🔴. **Exit:** a seller checks out, cannot oversell, sells, returns, settles with an itemized split payout, and a dispute correctly gates a Trust Score change.

## Phase 5 — Growth Mechanics 🟡🔴  (Product Milestone 4)
*The feature is easy; the fraud surface is the hard part.*

- `growth`: ping budgets + paid tips + qualifying-action gate + daily cap + unique-recipient constraint + device-fingerprint dedupe + fraud-flag queue.
- Gifting (redemption/expiry), giveaways (daily cap), Spot Me (age/tier gate, reputation consequence).
- Block Party detection sweep + broadcast (geohash cluster scan).
- **Dependencies:** Phases 2 & 4 (transaction + trust infra). **Complexity:** 🔴 on fraud. **Exit:** paid pings pay tips only to genuinely qualifying recipients; farming attempts are flagged, not paid.

## Phase 6 — AI Layer v1 (rule-based) 🟡  (Product Milestone 5)
- `ai`: product/location recs (affinity + proximity + time-of-day) with `reason_summary`; pricing suggestion; sales-coaching content library; basic hub dashboard reads.
- Interface drawn for **future Python/FastAPI extraction** (no ML yet — needs real transaction data first).
- **Dependencies:** Phase 4 (needs real data). **Complexity:** 🟡. **Exit:** explainable, advisory recommendations served from real first-party signals.

## Phase 7 — Jobs & Shelter Program 🟡  (Product Milestone 6)
- `jobs`: postings, ranked nearby feed, apply/accept, QR/tap check-in-out → same-day payout (pilot uses explicit tap check-in, not background geofence).
- `shelter`: admin-verified partner orgs, capped cosign enrollment, aggregate privacy-preserving reporting.
- **Dependencies:** Phases 0, 4 (verification tiers). **Complexity:** 🟡 technical / 🔴 legal (partner + resident agreements reviewed before ship).

## Phase 8 — Pilot Launch Hardening 🔴  (Product Milestone 7)
- Load test realtime + geospatial (10k concurrent sessions/metro); tune indexes, cache TTLs, sweep cadences.
- Full monitoring/alerting live; runbooks; DLQ + on-call for financial jobs.
- Targeted pen-test on auth + payment + authorization surfaces; Stripe live-mode sign-off.
- Staged rollout + sponsor integration (Wonder Ice).
- **Dependencies:** Phases 1–5 minimum (6–7 can follow launch). **Exit:** pilot-ready per NFRs (P95 latency, 99.5% uptime, SLA dashboards green).

## Post-Launch — V1.x & Future
- ML demand prediction (Python microservice), product-to-seller matching, Smart Event Selling, AI Academy, full three-way reputation with tier-gated inventory, sponsor dashboard.
- Then explicitly-future items (smart lockers, NFC, AI Vision Verification, autonomous inventory, AI income coach, inventory insurance, featured-placement ads) — **sequenced by demonstrated demand, not built speculatively**.

---

## Critical Path & Parallelization

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3
                 │           └────────────┐
                 └──► Phase 4 ──► Phase 5  │
                          └──► Phase 6     │
                          └──► Phase 7     │
   (Phases 3, 4 can proceed in parallel after 1–2; 5 needs 2+4; 8 gates launch)
```

- **Longest pole:** Phases 1→2→4 (payments → realtime → consignment) — the three 🔴 blocks. Front-load and protect these.
- **Parallelizable:** Phase 3 (scheduling/dashboard) alongside Phase 4; Phase 6 (AI) alongside Phase 7 once Phase 4 data exists.
- **Do not** start Phase 5 fraud work before Phases 2 and 4 exist to defraud.

## Complexity/Risk Summary

| Phase | Complexity | Primary risk |
|---|---|---|
| 0 Foundations | 🟡 | Wrong primitives are costly to unwind |
| 1 Identity/Vendors/Payments | 🔴 | Financial correctness, KYC async |
| 2 Live Map/Realtime | 🔴 | Hot-path scale, geohash fan-out |
| 3 Scheduling/Dashboard | 🟡 | State-machine edge cases |
| 4 Consignment | 🔴 | Oversell + settlement atomicity (the Mongo-bites path) |
| 5 Growth | 🔴 | Fraud surface |
| 6 AI v1 | 🟡 | Explainability, avoiding premature ML |
| 7 Jobs/Shelter | 🟡/🔴 | Legal/compliance gating |
| 8 Launch | 🔴 | Load, money live-mode, authz pen-test |
