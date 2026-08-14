# StreetServe — Backend Architecture

> **Status:** Planning blueprint (no production code). Single source of truth for backend implementation.
> **Companion docs:** [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md), [MODULE_BREAKDOWN.md](MODULE_BREAKDOWN.md), [DATABASE_SCHEMA_PLAN.md](DATABASE_SCHEMA_PLAN.md), [REALTIME_ARCHITECTURE.md](REALTIME_ARCHITECTURE.md).
> **Derived from:** `STREET-SERVE-APPLICATION/docs/01–13`.

---

## 0. Confirmed Stack (this project)

The product docs *recommend* PostgreSQL + PostGIS but explicitly accept **full MongoDB** as a valid MERN-native path ("A shipped pilot on Mongo beats a stalled one on Postgres"). This backend is built on the MongoDB path per the project brief. Every place the product docs warn that "Mongo bites" is addressed explicitly below and in [DATABASE_SCHEMA_PLAN.md](DATABASE_SCHEMA_PLAN.md).

| Concern | Choice | Notes |
|---|---|---|
| Runtime | **Node.js 20 LTS** | — |
| Language | **TypeScript (strict)** | `strict: true`, no implicit `any`, especially on money/inventory paths |
| Framework | **Express.js 4** | Disciplined modular folder structure (see PROJECT_STRUCTURE). NestJS considered and declined for pilot velocity. |
| Primary DB | **MongoDB 7+ (Atlas)** | Replica set required (multi-document transactions need it). `2dsphere` geo indexes. |
| ODM | **Mongoose 8** | Schema validation, middleware, typed models |
| Cache / hot path | **Redis 7** (Upstash/managed) | Live-location mirror, rate-limit counters, session cache, geohash hot-reads, BullMQ + Socket.IO adapter backing store |
| Realtime | **Socket.IO 4 + `@socket.io/redis-adapter`** | Redis adapter mandatory from day one (multi-instance) |
| Background jobs | **BullMQ** (Redis-backed) | Settlement, Trust Score, notification fan-out, ping-fraud, SLA sweeps |
| Auth (identity/login) | **Clerk** (primary) or **Auth0** | Managed OTP/session/brute-force; JWT verified via JWKS at the API edge |
| KYC / identity verification | **Stripe Identity** (primary) or **Persona** | Hosted web flow; we store only a provider reference + status |
| Payments / money movement | **Stripe Connect** (+ Stripe Tax) | Non-negotiable per docs. Never a custom ledger. |
| Object storage | **Cloudflare R2** (S3-compatible) | Condition/product/profile photos, dispute evidence, behind CDN, presigned uploads |
| SMS / OTP bridge | **Twilio** | The reliable alert bridge for the 4 background-blocked interactions |
| Email | **Postmark** (or SES) | Transactional only |
| Push | **Firebase Cloud Messaging** | Web push (PWA) + future native |

**Deployment target:** containerized long-lived service on Render / Railway / Fly.io (NOT serverless — WebSockets require persistent processes). See [DEPLOYMENT_STRATEGY.md](DEPLOYMENT_STRATEGY.md).

---

## 1. Architectural Style

**A modular monolith, deployed as one horizontally-scalable Node/Express service, with a clean internal module boundary that permits later extraction into services if scale demands.**

Rationale:
- The pilot is one city (Modesto, CA). A microservice mesh is operational complexity the pilot does not need (the docs explicitly say "avoid Kubernetes for a one-city pilot").
- But the *internal* boundaries (domain modules, an event bus, a payments boundary, a realtime boundary) are drawn as if they were services, so the AI/recommendation Python microservice — the one deliberate future extraction the docs name — and any later split are a lift, not a rewrite.
- One process, many instances behind a load balancer. Shared state lives in MongoDB (durable) and Redis (hot/ephemeral), never in process memory — this is what makes horizontal scaling correct rather than aspirational.

```
                        ┌───────────────────────────────────────────┐
   Web (Next.js PWA)    │              Load Balancer                 │
   Dashboards (React)   │        (sticky sessions for WS)            │
        │  HTTPS + WSS   └───────────────────┬───────────────────────┘
        ▼                                    │
┌─────────────────────────────────────────────────────────────────────┐
│                   StreetServe API (Node + Express + TS)              │
│  N horizontally-scaled instances — no in-process state               │
│                                                                     │
│  ┌───────────────┐  ┌────────────────┐  ┌────────────────────────┐  │
│  │ HTTP layer    │  │ Socket.IO layer│  │ BullMQ workers          │  │
│  │ routes →      │  │ /live /queue   │  │ (can run in-process or  │  │
│  │ controllers → │  │ /notifications │  │  as a separate worker   │  │
│  │ services      │  │ /messages      │  │  dyno, same codebase)   │  │
│  └──────┬────────┘  └───────┬────────┘  └───────────┬────────────┘  │
│         │                   │                       │               │
│         └───────────────────┴───────────────────────┘               │
│                        Domain Modules                                │
│  identity · vendors · livemap · queue · orders · payments · consign- │
│  ment · trust · disputes · growth(ping/gift/spotme) · scheduling ·   │
│  jobs · shelter · ai · notifications · admin                         │
│                        Internal Event Bus                            │
│                (BullMQ + Redis Streams for domain events)            │
└───────┬───────────────────┬──────────────────┬─────────────┬────────┘
        │                   │                  │             │
        ▼                   ▼                  ▼             ▼
 ┌────────────┐     ┌───────────────┐   ┌────────────┐  ┌──────────────┐
 │  MongoDB   │     │    Redis      │   │  Stripe    │  │ R2 / Twilio  │
 │  (system   │     │  hot state +  │   │  Connect   │  │ FCM / Postmark│
 │ of record) │     │  pub/sub +    │   │ (money =   │  │ Clerk / Stripe│
 │            │     │  queues       │   │  truth)    │  │ Identity      │
 └────────────┘     └───────────────┘   └────────────┘  └──────────────┘
```

**Systems of record (authoritative source of truth per data class):**
- **Money:** Stripe Connect. MongoDB stores an itemized *mirror/ledger* of every transfer for display and audit, but Stripe is authoritative for balances and payouts.
- **Everything else (users, vendors, inventory, trust, disputes):** MongoDB.
- **Live location (hot):** Redis (short-TTL, low-latency broadcast source). MongoDB `live_sessions` holds the durable/auditable last-known row; raw high-frequency ping history goes to a capped/TTL collection, not the hot path.

---

## 2. Request Lifecycle (HTTP)

```
Request
  → TLS termination (platform)
  → Load balancer
  → Express app
    → requestId + correlationId middleware (AsyncLocalStorage)
    → structured request logger (pino)
    → Helmet security headers + CORS (allowlisted origins)
    → body parser (size-limited) + JSON
    → rate limiter (Redis-backed, per-route + per-account tier)
    → auth middleware (verify Clerk/Auth0 JWT via JWKS → attach principal)
    → role/permission guard (RBAC — see AUTHENTICATION_AND_AUTHORIZATION.md)
    → idempotency middleware (money-mutating POSTs only)
    → Zod request-schema validation (body/query/params; unknown fields rejected)
    → controller (thin — no business logic)
      → service (business logic, owns transactions)
        → repository (Mongoose models) / external adapters (Stripe, KYC, …)
    → response envelope serializer
  → error-handling middleware (last) → standard error envelope
```

Every layer is thin and single-purpose. Business rules live in **services**; controllers only translate HTTP↔service. See [MODULE_BREAKDOWN.md](MODULE_BREAKDOWN.md) and [ERROR_HANDLING_STRATEGY.md](ERROR_HANDLING_STRATEGY.md).

---

## 3. The Two "Mongo Bites" — Explicit Mitigations

The product docs flag exactly two workloads that Postgres would give us for free and Mongo makes us engineer. Both are first-class in this architecture.

### 3.1 Financial & inventory integrity (oversell guard, settlement atomicity)

- **Multi-document transactions** (`session.withTransaction`) wrap every money- or inventory-mutating operation that spans documents (checkout→inventory decrement, sale→settlement, Spot Me, gift redemption). Requires a MongoDB **replica set** (Atlas provides this by default).
- **Oversell guard (FR-8.3)** is enforced with a *conditional atomic update*, not a read-then-write:
  ```
  db.inventory_checkouts.updateOne(
    { _id, $expr: { $lte: [ { $add: ["$quantity_sold", newQty] }, "$quantity" ] } },
    { $inc: { quantity_sold: newQty } }
  )
  ```
  If `matchedCount === 0`, the sale exceeded checked-out quantity → reject with `409 OVERSELL`. This makes the guard race-safe without a lock.
- **Immutable financial rows:** `settlements`, `transactions` (once completed), and any audit entry are append-only. Corrections are new offsetting documents, never in-place updates (enforced by service-layer policy + Mongoose pre-update hooks that reject updates on immutable collections). See [VALIDATION_RULES.md](VALIDATION_RULES.md).
- **Money is always integer cents** (`Int32`/`Long`), never floats, everywhere.
- **Stripe is the source of truth for balances**; our documents are a reconciled mirror. A nightly reconciliation job (BullMQ) diffs our ledger vs. Stripe and raises a fraud/ops flag on drift.

### 3.2 Geospatial: proximity, and Block Party detection (FR-4.2)

- **`2dsphere` indexes** on all geo fields (`live_sessions.current_location`, `users.home_location`, `businesses.service_area`, `products`/hub location, `jobs_postings.location`). `$geoNear` / `$near` / `$geoWithin` cover proximity, radius search, and "nearby" feeds.
- **Block Party detection ("≥2 vendors within 150m for ≥10 min")** is a compound geo+time+relational query PostGIS does in one statement; on Mongo it is a **BullMQ scheduled job** running an application-level sweep:
  1. Pull active `live_sessions` (from the Redis hot mirror) bucketed by **geohash** cell (precision ~6 ≈ 1.2km, with neighbor-cell checks to avoid boundary misses).
  2. Within candidate clusters, compute pairwise distances; find groups of ≥2 within the radius.
  3. Confirm the cluster has persisted ≥ the overlap window using each session's `cluster_first_seen_at` tracked in Redis.
  4. On confirmation, write a `block_party_events` doc and enqueue a broadcast job.

  This is exactly the "compute Block Party detection in application code" the docs told us to budget for.

---

## 4. Cross-Cutting Concerns

| Concern | Approach |
|---|---|
| **Config** | 12-factor env vars, validated at boot with Zod (`config.ts` fails fast on missing/invalid). Secrets from platform secret store, never in repo. |
| **Correlation** | `requestId` + `correlationId` via `AsyncLocalStorage`, propagated to logs, jobs, and socket events. |
| **Idempotency** | `Idempotency-Key` header on all payment-triggering POSTs; keys stored in Redis (24h TTL) with the first response cached. |
| **Validation** | Zod at the HTTP edge; Mongoose schema validation as the storage backstop. Never trust client-supplied role, price, discount, or fee. |
| **Time & money** | UTC everywhere; money in integer cents; server timestamps are authoritative for queue position, wave-down SLA, settlement. |
| **Feature flags & city scoping** | `cities` collection + config flags. New city = data/config change, not a redeploy. Consignment layer is gated to launch cities. |
| **Auditability** | Append-only `audit_logs` for every payout, dispute action, role elevation, Trust Score change, admin action (actor, timestamp, reason). |

---

## 5. Domain Event Bus (internal)

Domain modules communicate via **published events**, not direct cross-service calls, for anything asynchronous or fan-out shaped. Backing implementation: **BullMQ queues** for guaranteed-delivery work + **Redis pub/sub** for realtime broadcast. This keeps modules decoupled and makes the request path fast (a settlement request returns as soon as the money moves; Trust Score recompute, receipt email, and notification fan-out happen off the request path).

Representative events (full catalog in [BACKGROUND_JOBS.md](BACKGROUND_JOBS.md) and [REALTIME_ARCHITECTURE.md](REALTIME_ARCHITECTURE.md)):

| Event | Emitted by | Consumed by |
|---|---|---|
| `live_session.location_updated` | livemap | realtime broadcast, geohash cache, block-party sweep |
| `wave_down.accepted` | queue | notifications, realtime (ETA to requester) |
| `inventory.settled` | consignment | payments (payout), trust (recompute), notifications (receipt) |
| `dispute.resolved` | disputes | trust (apply score change post-resolution), notifications, audit |
| `ping.qualified` | growth | payments (tip transfer), fraud scoring |
| `transaction.completed` | payments | trust, notifications, reviews-eligibility |
| `block_party.detected` | jobs(sweep) | notifications (fan-out to opted-in nearby users) |

---

## 6. Failure & Degradation Posture

Maps to NFR "graceful degradation" and 99.5% pilot uptime.

- **Redis down:** realtime and rate-limiting degrade, but money/inventory writes (MongoDB + Stripe) continue. Live map falls back to last-known pins from `live_sessions` (Mongo), served with a "may be stale" flag. Never block a payout because the cache is down.
- **Stripe webhook lag:** verification/settlement statuses are eventually-consistent by design; the client polls/receives a socket update on resolution. We never assume synchronous payout confirmation.
- **KYC provider down:** verification submissions queue as `pending`; the tier gate simply keeps the user at their current tier — fail closed on capability, not open.
- **Circuit breakers + timeouts + retries with jitter** on every outbound third-party call (Stripe, Twilio, FCM, KYC, R2). See [THIRD_PARTY_INTEGRATIONS.md](THIRD_PARTY_INTEGRATIONS.md).
- **Idempotent retries** everywhere money moves, so a flaky mobile connection retrying a charge never double-charges.

---

## 7. Scalability Summary

Detailed in [SECURITY_GUIDELINES.md](SECURITY_GUIDELINES.md) §Scalability and [REALTIME_ARCHITECTURE.md](REALTIME_ARCHITECTURE.md); headline decisions:

- **Live location is the hot path.** Per-second location writes go to Redis, never MongoDB. Mongo persists a throttled snapshot (~every 10s per FR-1.2) plus a TTL'd ping-history collection.
- **Geohash-bucketed subscriptions:** clients subscribe to the map cells in view, not a global firehose — bounds broadcast fan-out independent of total user count. Designed for 10k concurrent live sessions per metro (NFR Scalability).
- **Socket.IO Redis adapter** so realtime is correct across N instances.
- **BullMQ** absorbs bursty async work off the request path.
- **MongoDB:** compound indexes on every hot query; read concern/write concern tuned per collection (majority write concern on money; faster concerns on logs). Analytics/dashboard reads move to a secondary/replica read preference as load grows.
- **Design for one city, architect for many:** geohash + `2dsphere` + city-scoped flags make expansion a config change.
