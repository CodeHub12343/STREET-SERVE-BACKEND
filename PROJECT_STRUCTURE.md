# StreetServe — Backend Project Structure

> Folder layout, layering conventions, and file responsibilities for the Node + Express + TypeScript + MongoDB service.
> Companion: [MODULE_BREAKDOWN.md](MODULE_BREAKDOWN.md), [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md).

---

## 1. Layering Rules (enforced)

```
route → controller → service → repository/model → MongoDB
                        │
                        └→ adapter (Stripe, KYC, Twilio, FCM, R2, ...)
```

- **Routes** wire paths to controllers + attach middleware (auth, RBAC, validation, rate limit, idempotency). No logic.
- **Controllers** are thin: parse the validated request, call one service method, shape the HTTP response. No business rules, no DB access.
- **Services** own all business logic and MongoDB transactions. The only layer allowed to orchestrate across repositories/adapters and emit domain events.
- **Repositories / Models** are the only layer that touches Mongoose. No business rules leak here.
- **Adapters** wrap third-party SDKs behind an internal interface (so Stripe/Clerk/etc. are swappable and mockable).

Dependency direction is strictly downward. A service may call another module's **service** (public API of the module), never another module's repository or model directly.

---

## 2. Directory Layout

```
streetserve-backend/
├── src/
│   ├── app.ts                     # Express app assembly (middleware chain, route mount)
│   ├── server.ts                  # HTTP + Socket.IO bootstrap, graceful shutdown
│   ├── worker.ts                  # BullMQ worker entrypoint (same image, different start cmd)
│   │
│   ├── config/
│   │   ├── env.ts                 # Zod-validated env → typed config (fail fast at boot)
│   │   ├── db.ts                  # Mongoose connection (replica set, pool, read/write concern)
│   │   ├── redis.ts               # Redis clients (cache, pub/sub, bull, socket adapter)
│   │   ├── logger.ts              # pino instance + redaction rules
│   │   └── constants.ts           # enums, defaults (SLAs, caps, TTLs) sourced from PRD
│   │
│   ├── middleware/
│   │   ├── auth.ts                # verify Clerk/Auth0 JWT (JWKS), attach principal
│   │   ├── rbac.ts                # requireRole / requirePermission / requireOwnership
│   │   ├── validate.ts            # Zod schema runner (body/query/params)
│   │   ├── idempotency.ts         # Idempotency-Key handling (Redis)
│   │   ├── rateLimit.ts           # Redis-backed limiter factory (per-route tiers)
│   │   ├── requestContext.ts      # requestId/correlationId via AsyncLocalStorage
│   │   └── errorHandler.ts        # final error → standard envelope
│   │
│   ├── modules/                   # one folder per domain module (see MODULE_BREAKDOWN)
│   │   └── <module>/
│   │       ├── <module>.routes.ts
│   │       ├── <module>.controller.ts
│   │       ├── <module>.service.ts
│   │       ├── <module>.repository.ts
│   │       ├── <module>.model.ts        # Mongoose schema(s) for this module
│   │       ├── <module>.schema.ts       # Zod request/response schemas
│   │       ├── <module>.events.ts       # event names + payload types this module emits
│   │       └── <module>.test.ts
│   │
│   ├── realtime/
│   │   ├── io.ts                  # Socket.IO server + Redis adapter setup
│   │   ├── namespaces/            # /live, /queue, /notifications, /messages
│   │   ├── socketAuth.ts          # handshake JWT auth + room authorization
│   │   └── emitters.ts            # typed server→client emit helpers
│   │
│   ├── jobs/
│   │   ├── queues.ts              # BullMQ queue definitions + connection
│   │   ├── scheduler.ts           # repeatable/cron jobs registration
│   │   └── processors/            # one file per job type (settlement, trust, sweeps...)
│   │
│   ├── events/
│   │   ├── bus.ts                 # publish/subscribe over BullMQ + Redis Streams
│   │   └── types.ts               # domain event catalog (typed payloads)
│   │
│   ├── integrations/              # third-party adapters (see THIRD_PARTY_INTEGRATIONS)
│   │   ├── stripe/                # Connect, PaymentIntents, Tax, transfers, webhooks
│   │   ├── kyc/                   # Stripe Identity / Persona adapter (single interface)
│   │   ├── auth/                  # Clerk/Auth0 token verification + user sync
│   │   ├── sms/                   # Twilio
│   │   ├── push/                  # FCM
│   │   ├── email/                 # Postmark
│   │   └── storage/               # R2 presigned uploads
│   │
│   ├── shared/
│   │   ├── errors/                # AppError hierarchy + error codes registry
│   │   ├── money.ts               # cents helpers (never floats)
│   │   ├── geo.ts                 # geohash, distance, GeoJSON helpers
│   │   ├── pagination.ts          # cursor pagination helpers
│   │   ├── audit.ts               # append-only audit log writer
│   │   └── types/                 # shared TS types (Principal, Role, etc.)
│   │
│   └── webhooks/
│       ├── stripe.webhook.ts      # signature-verified, raw-body route
│       ├── kyc.webhook.ts
│       └── clerk.webhook.ts       # user lifecycle sync
│
├── migrations/                    # migrate-mongo scripts (indexes, seed enums, backfills)
├── seeds/                         # category taxonomy (~15–25), cities, fee schedule
├── test/                          # integration + e2e (supertest), test fixtures/factories
├── scripts/                       # ops scripts (reconcile, backfill, load-test harness)
├── .env.example
├── docker-compose.yml             # local: mongo (replica set), redis, mailhog
├── Dockerfile
├── tsconfig.json                  # strict: true
├── package.json
└── README.md
```

---

## 3. Why This Shape

- **Feature-cohesive modules over technical layers at the top level.** A change to "consignment settlement" touches one folder, not four scattered technical directories. This is the discipline that replaces NestJS's enforced structure (which the docs said we could skip for velocity) — the boundaries are conventional, but they are drawn.
- **`app.ts` vs `server.ts` vs `worker.ts` split** lets the same image run as (a) API+Socket.IO, or (b) a dedicated BullMQ worker dyno, scaling the two independently without a code split.
- **Adapters isolate every third party** behind an interface, so Clerk↔Auth0 or Stripe Identity↔Persona swaps (both named as "primary or" in the brief) are one-file changes, and every external call is mockable in tests.
- **`shared/errors` central registry** guarantees the single error envelope contract in [ERROR_HANDLING_STRATEGY.md](ERROR_HANDLING_STRATEGY.md).
- **`migrations/` + `seeds/`** — MongoDB is schemaless at the engine level, so index creation, enum seeds, and the curated category taxonomy are managed as explicit, reviewable, environment-promotable migrations (`migrate-mongo`), not implicit runtime side effects.

---

## 4. Naming & Convention Standards

| Item | Convention |
|---|---|
| Files | `kebab-case.ts` grouped by module; suffix by role (`.service.ts`, `.controller.ts`) |
| Mongoose models | Singular PascalCase (`User`, `InventoryCheckout`); collections plural snake_case (`inventory_checkouts`) to match the DB doc |
| Env vars | `SCREAMING_SNAKE_CASE`, namespaced (`STRIPE_`, `REDIS_`, `TWILIO_`) |
| Error codes | `SCREAMING_SNAKE_CASE` string codes from the central registry |
| Money fields | always `*_cents` integer |
| Geo fields | GeoJSON `{ type: "Point", coordinates: [lng, lat] }` — **lng first** |
| Timestamps | `*_at` UTC `Date`; created/updated auto via Mongoose `timestamps` |
| Async | `async/await` only; no floating promises (lint-enforced) |

---

## 5. Tooling

- **Build:** `tsc` (strict) + `tsx`/`ts-node-dev` for local reload.
- **Lint/format:** ESLint (`@typescript-eslint`, `no-floating-promises`, `no-explicit-any`) + Prettier.
- **Validation:** Zod (HTTP edge) + Mongoose schema (storage backstop).
- **Test:** Vitest/Jest (unit) + Supertest (HTTP integration) + `mongodb-memory-server` replica-set mode (transactions in tests) + ioredis-mock.
- **API contract:** OpenAPI 3.1 generated from Zod schemas (`zod-to-openapi`) → served at `/docs` in non-prod.
- **Commit gates:** typecheck + lint + unit tests on pre-push; full integration + dependency scan in CI (see DEPLOYMENT_STRATEGY).
