# Documentation index — backend

**Maintained as of 2026-08-02.** Start here. Every document at this root is labelled below so a
reader can tell at a glance what is still true.

| Label | Meaning |
|---|---|
| **Current** | Describes the system as it is. Trust it. |
| **Historical** | Was accurate when written and is kept as a record. Do not plan from it. |

The **planning documents live in the frontend repo**, not here — see
`../STREET-SERVE-APPLICATION/DOCS_INDEX.md`. In particular the active roadmap is
`audit/2026-08-marketplace-spec/IMPLEMENTATION_ROADMAP.md` over there. This repo's documents are
reference material for how the server works.

---

## Start here

| Document | Label | What it is |
|---|---|---|
| [README.md](README.md) | Current | Setup, scripts, and how to run the API and worker. |
| [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md) | Current | Env vars and local dependencies. **Note:** Node is not on `PATH` on the primary dev machine; commands need `C:\Program Files\nodejs` prepended, which is why `npm run verify` can fail out of the box. |
| [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) | Current | Where code goes. |
| [MODULE_BREAKDOWN.md](MODULE_BREAKDOWN.md) | Current | The 38 domain modules and what each owns. **Phase 7 added five more:** `promotions` (flash sales), `wishlists`, `loyalty` (stamps + referrals), `backoffice` (crew/expenses/invoices), and `integrations/messaging` (the outbound notice channel). |

## Architecture and contracts

All **Current**, and cited by section number from source comments — `VALIDATION_RULES.md §1` and
`API_SPECIFICATION.md §18` both appear in `shared/money.ts`, for example. Renaming a section here
orphans those references.

| Document | Covers |
|---|---|
| [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md) | Layering: routes → controller → service → repository |
| [API_SPECIFICATION.md](API_SPECIFICATION.md) | The `/api/v1` surface, response envelope, pagination |
| [DATABASE_SCHEMA_PLAN.md](DATABASE_SCHEMA_PLAN.md) | Collections, indexes, and why each exists |
| [AUTHENTICATION_AND_AUTHORIZATION.md](AUTHENTICATION_AND_AUTHORIZATION.md) | Clerk, principals, RBAC permissions |
| [VALIDATION_RULES.md](VALIDATION_RULES.md) | Zod conventions; integer-cents discipline |
| [ERROR_HANDLING_STRATEGY.md](ERROR_HANDLING_STRATEGY.md) | `AppError` taxonomy and error codes |
| [REALTIME_ARCHITECTURE.md](REALTIME_ARCHITECTURE.md) | Socket rooms, presence, emissions |
| [BACKGROUND_JOBS.md](BACKGROUND_JOBS.md) | BullMQ queues, sweeps, schedules |
| [THIRD_PARTY_INTEGRATIONS.md](THIRD_PARTY_INTEGRATIONS.md) | Stripe, Clerk, Gemini, KYC, storage, weather |
| [SECURITY_GUIDELINES.md](SECURITY_GUIDELINES.md) | Idempotency, rate limits, webhook verification |
| [LOGGING_AND_MONITORING.md](LOGGING_AND_MONITORING.md) | Structured logs, audit trail |
| [DEPLOYMENT_STRATEGY.md](DEPLOYMENT_STRATEGY.md) | Environments and release process |
| [RUNBOOKS.md](RUNBOOKS.md) | On-call procedures — read before touching production money paths |
| [SUPPORT_RUNBOOKS.md](SUPPORT_RUNBOOKS.md) | **For support, not on-call.** RTO delinquency, consignment termination, disputes — plus what support deliberately cannot do. |
| [LOAD_TEST_PLAN.md](LOAD_TEST_PLAN.md) | Projected launch volume, the traffic mix, and what a green run would *not* prove. The run itself is still outstanding. |

## Security and compliance

**Current.** Written in roadmap Phase 6.

| Document | What it is |
|---|---|
| [SECRET_MANAGEMENT_REVIEW.md](SECRET_MANAGEMENT_REVIEW.md) | How secrets are handled, what was fixed, and the five deployment-platform questions the repo cannot answer. |

## Performance and capacity

**Current.** Written in roadmap Phase 5.

| Document | What it is |
|---|---|
| [SWEEP_LOAD_MODEL.md](SWEEP_LOAD_MODEL.md) | Every scheduled sweep modelled against projected volume: capacity, where each saturates, and the three to fix before launch scale. Arithmetic, not measurement — says so. |
| [INDEX_COVERAGE_REVIEW.md](INDEX_COVERAGE_REVIEW.md) | Static index-coverage audit. Three missing indexes found and fixed; the traffic-dependent half (unused indexes) is explicitly deferred. |

## Security

**Current.** Written in roadmap Phase 6.

| Document | What it is |
|---|---|
| [SECRET_MANAGEMENT_REVIEW.md](SECRET_MANAGEMENT_REVIEW.md) | How secrets are handled: what was checked, two findings fixed, and five platform questions the repo cannot answer — named rather than blurred into a pass. |

## Inventory and history

| Document | Label | Note |
|---|---|---|
| [BACKEND_FEATURE_INVENTORY.md](BACKEND_FEATURE_INVENTORY.md) | Current | What the server implements, module by module |
| [BACKEND_IMPLEMENTATION_ROADMAP.md](BACKEND_IMPLEMENTATION_ROADMAP.md) | **Historical** | Delivered. The active plan is the frontend repo's audit roadmap. |
| [IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md) | **Historical** | Delivered. Superseded by `audit/2026-08-marketplace-spec/FINAL_IMPLEMENTATION_CHECKLIST.md` in the frontend repo. |

---

## Seven gates run in CI

Not documents, but the places where architectural decisions are enforced rather than described:

| File | Enforces |
|---|---|
| `test/enumReachability.test.ts` | No enum value is declared without a writer (A-2). Carries the known-unwritten baseline. |
| `test/routeCoverage.test.ts` | No route ships without a test (A-1, server side). Carries the untested-route baseline. |
| `test/money.test.ts` | The two money conventions: rates round down, split legs reconcile exactly (A-5). |
| `test/feeCache.test.ts` | Fee-schedule invalidation reaches peers, deletes the shared copy before announcing, and can never fail a charge (A-3). |
| `test/envDocumentation.test.ts` | Every env var the app reads is documented in `.env.example`, and no real-looking key is committed (6.2). |
| `test/integrityAlerts.test.ts` | A seeded ledger drift or unbalanced transaction is detected AND pages (8.3). |
| `test/runbookRehearsal.test.ts` | Every metric, script, and endpoint a runbook names still exists (8.2). |
| `test/envDocumentation.test.ts` | Every env var the app reads is documented in `.env.example`, and no real-looking key is in it (6.2). |
| `test/moneyPathAttacks.test.ts` | 19 adversarial attacks on the money paths, run every commit (6.3). Not a pen test — see its header. |
| `scripts/check-vulnerabilities.mjs` | No unreviewed high+ CVE in the production dependency tree; exceptions expire (6.1). |

Each has a baseline that **may shrink and never grow**. That is the mechanism; the numbers are in
the files.

## Rule for adding a document

Add a row here in the same commit. An index that lags the folder is worse than none — it makes a
stale document look vouched-for.
