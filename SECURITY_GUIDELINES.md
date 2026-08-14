# StreetServe — Security Guidelines & Scalability Strategy

> Consolidates `docs/10-security-and-scalability.md` into enforceable backend guidance, adapted to the MongoDB stack.
> Companion: [AUTHENTICATION_AND_AUTHORIZATION.md](AUTHENTICATION_AND_AUTHORIZATION.md), [VALIDATION_RULES.md](VALIDATION_RULES.md), [LOGGING_AND_MONITORING.md](LOGGING_AND_MONITORING.md).

---

## 1. Data Protection

- **PII** (name, phone, email, location history) encrypted **at rest** (Atlas encryption-at-rest / field-level encryption for the most sensitive fields) and **in transit** (TLS everywhere, including internal service-to-service and MongoDB/Redis connections).
- **ID/selfie documents are never stored by StreetServe** — they live with the KYC provider; we keep only a reference + status (Q7). Minimizes breach and CCPA blast radius.
- **Location precision is user-controlled** (`users.location_precision`): exact used server-side for matching/proximity; public pin display can be fuzzed to a configurable radius for sellers who want it. Fixed-location vendors may show exact.
- **Retention:** precise location history purged/aggregated at **30 days** (TTL index on `location_pings`), surfaced to users at signup (Q7). City-level aggregates may be retained.
- **Secrets** in the platform secret store, never in the repo; rotated; scoped per environment.
- **Field-level encryption** candidates: phone, `recipient_contact_hash` salt, any residual PII on shelter enrollments.

## 2. Payment & Financial Security

- **No raw card/bank data touches our servers** — Stripe Elements/Payment Element + Stripe Connect hosted onboarding. PCI scope stays **SAQ A**.
- **All settlement/payout math computed server-side**, never trusted from client input.
- **Idempotency keys** on every payment-triggering request (duplicate key → cached response, never a second charge). Critical for a field-used mobile app on flaky connections.
- **Immutable financial audit trail:** `settlements`, completed `transactions`, `audit_logs` are append-only; corrections are new offsetting docs, never destructive updates. Enforced by Mongoose pre-update hooks + service policy.
- **Stripe is the source of truth for balances.** A nightly reconciliation job diffs our ledger mirror vs. Stripe; drift raises an ops/fraud flag.
- **Accurate business-category declaration on a freshly opened Stripe Connect account** (Q5) — never a renamed/repurposed legacy account. This is the explicit, correct counter to the misrepresentation pattern flagged in the excluded chat log (Exec §2). Building any workaround around processor compliance is prohibited.
- **Stripe Tax** for marketplace-facilitator sales tax on consignment sales — obligation sits centrally with StreetServe (Q3).

## 3. Fraud & Abuse Prevention

| Vector | Control |
|---|---|
| **Ping economy farming** | Per-account daily paid-share cap (default 10); unique-recipient-per-vendor partial unique index; new/dormant-account qualifying condition; device-fingerprint dedupe; hold payouts on new accounts briefly |
| **Consignment oversell** | Atomic conditional `$inc` guard (FR-8.3) — race-safe, no read-then-write |
| **Spot Me abuse** | Disabled <30-day age or <Bronze; repeated defaults reduce Trust Score and disable the feature per-user; reputation consequence, not collections |
| **Fake/duplicate accounts** | Phone/OTP at minimum for every account; device + behavioral signals feed a **manual fraud-flag review queue** (not fully automated bans — the docs stress the real cost of wrongly banning a legitimate low-income seller) |
| **Review manipulation** | Reviews only tied to a completed transaction (unique `transaction_id`) |
| **Sybil on tips/gifts** | Contact-hash uniqueness + fingerprint + payout hold window |

Fraud posture is **flag-for-human-review, not auto-ban**, given the vulnerable-population user base.

## 4. Input Validation & API Hardening

- **Zod schema validation** on every request body/query/params, rejecting unknown fields (mass-assignment defense). See [VALIDATION_RULES.md](VALIDATION_RULES.md).
- **Rate limiting** per-endpoint and per-account, Redis-backed, tuned **tighter on money-movement and sharing** than on read-only map queries. Suggested tiers:
  - Read/map: generous (e.g., 120/min/user).
  - Write/general: moderate (e.g., 30/min/user).
  - Money/sharing/auth: strict (e.g., 5–10/min/user + per-IP + per-device caps).
- **Helmet** security headers; **strict CORS** allowlisted to known app origins; **CSP** on any web-served surface.
- **Body size limits**, request timeouts, and payload depth limits.
- **NoSQL-injection defense (MongoDB-specific):** never pass raw user input into query objects; forbid operator injection (`$`/`.` keys) via input sanitization and by constructing queries from typed, validated values only — the Mongo analog of "parameterized queries." Mongoose casting + Zod pre-validation covers this; explicitly strip `$`-prefixed keys from any object-shaped input.
- **Dependency vulnerability scanning** in CI (npm audit / Snyk / Dependabot); fail the build on high-severity.

## 5. OWASP Top-10 Callouts (this product)

- **A01 Broken Access Control — highest risk here.** 9 roles × multi-role × money movement. Mitigation: three-layer authz (role/ownership/tier), central permission matrix, and **mandatory automated "wrong actor → 403" tests** for every cross-user + money action. See [AUTHENTICATION_AND_AUTHORIZATION.md](AUTHENTICATION_AND_AUTHORIZATION.md).
- **A03 Injection.** NoSQL-injection guards above; Mongoose (typed queries) rather than hand-built query objects from raw input.
- **A04 Insecure Design.** Tiered verification is a security control; changes to it require sign-off.
- **A09 Security Logging/Monitoring Failures.** Every dispute, payout, role-elevation, suspension logged with actor/timestamp/reason; anomaly alerting.
- **A02 Cryptographic Failures.** TLS everywhere; encryption at rest; no secrets in code; contact hashes salted.
- **A07 Auth failures.** Delegated to managed provider (brute-force, rotation) + short tokens + reuse-detection.

## 6. Compliance Posture

- **PCI:** delegated to Stripe (SAQ A).
- **KYC/AML:** per payout tier, provider-handled documents.
- **CCPA (California pilot):** minimal PII retention, no independent document storage, data-retention policy surfaced at signup, deletion/export honored (delegate document deletion to provider).
- **Marketplace facilitator tax:** Stripe Tax, central remittance.
- **Content moderation** for photos/reviews/messages (V1.x): rate-limited + moderated threads now; automated + human moderation pipeline later.

---

## 7. Scalability Strategy

Maps to NFR: 10k concurrent live sessions per metro, P95 <300ms reads / <800ms writes, 99.5% uptime.

- **Live location is the hot path.** Per-second location writes go to **Redis**, never MongoDB. Clients subscribe to **geohash-bucketed** map cells in view (not a global firehose), bounding broadcast fan-out independent of total user count.
- **Socket.IO Redis adapter** so realtime is correct across N horizontally-scaled instances (single-instance assumptions break past one process — baked in from day one).
- **Stateless API instances** behind a load balancer; all shared state in Mongo/Redis. Sticky sessions for WebSocket upgrade.
- **BullMQ** absorbs bursty async work (Trust recompute, Block Party fan-out, notification blasts) off the request path.
- **MongoDB scaling:** compound indexes on every hot query; `majority` write concern on money collections, relaxed on logs; **read preference to secondaries** for dashboards/analytics as read load grows; **sharding** deferred (single-city pilot won't need it), but shard keys (e.g., `city_id` / geohash) chosen now so it's a later config, not a re-model.
- **Caching hot reads** in Redis with short TTLs: active-vendor-list-per-geohash-cell, category taxonomy, discount schedules, fee schedule.
- **Design for one city, architect for many:** geohash + `2dsphere` + city-scoped feature flags make expansion a data/config change (new `cities` row, per-jurisdiction category/license metadata), not a re-architecture.

## 8. Risk Register (backend view)

| Risk | Category | Mitigation |
|---|---|---|
| Vendor operates without required local license | Legal | `requires_license` metadata blocks going live without approved docs |
| Ping economy bot/farming abuse | Fraud | Rate caps, uniqueness constraint, fingerprinting, manual review queue |
| Spot Me defaults harm vulnerable users | UX/Business | Age/tier gating, reputation consequence not collections |
| Shelter residents lack KYC artifacts | Compliance | Shelter-cosigned capped allocation as alternate verification path |
| Payment processor account review risk | Compliance | Accurate category declaration, fresh Connect account, no workarounds |
| Realtime infra fails to scale past pilot | Technical | Redis pub/sub + geohash bucketing designed in from day one; load-tested pre-expansion |
| **Mongo transaction discipline gaps** (money/oversell) | Technical | Multi-doc transactions + atomic conditional guards + immutability hooks + nightly reconciliation (see [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md) §3.1) |
| Trust Score gameable/unfair | Product | Versioned, explainable formula; dispute-resolution-gated changes |
| Broken access control (9-role money surface) | Security | Three-layer authz + mandatory automated authz tests |
| Scope creep from future-roadmap list | Delivery | Strict MVP/V1.x/Future tiering enforced in planning |

## 9. Security Testing & Gates
- Static analysis + dependency scan in CI (fail on high severity).
- Automated authorization test suite (A01) is a **merge gate** for any money-movement change.
- Secrets scanning (gitleaks) pre-commit + CI.
- Staging mirrors prod for payment + geospatial paths; Stripe test mode in dev/staging.
- Pre-launch: load test on realtime/geospatial paths; targeted pen-test on auth + payment + authz surfaces.
