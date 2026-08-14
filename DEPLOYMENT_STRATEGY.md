# StreetServe — Deployment Strategy

> Environments, containerization, hosting, CI/CD, data services, and release practice for the pilot and its path to multi-city.
> Principle from the docs: **match infra complexity to pilot-stage traffic** — containerized long-lived services on a managed platform, **not Kubernetes, not serverless**.
> Companion: [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md), [LOGGING_AND_MONITORING.md](LOGGING_AND_MONITORING.md).

---

## 1. Why Not Serverless, Why Not Kubernetes (pilot)

- **Not serverless:** the API hosts a **persistent Socket.IO server** and long-lived WebSocket connections. Serverless functions don't hold WebSockets (the docs call this "the WebSockets-don't-run-in-serverless trap"). The backend must be a long-lived process.
- **Not Kubernetes:** a single-city pilot doesn't justify K8s operational overhead. Use a managed container platform now; migrate to AWS ECS/EKS only once traffic/cost justifies it.

---

## 2. Runtime Topology

Two process types from **one Docker image**, different start commands, scaled independently:

| Process | Command | Scales on |
|---|---|---|
| **api** (HTTP + Socket.IO) | `node dist/server.js` | request + socket load; sticky sessions for WS |
| **worker** (BullMQ) | `node dist/worker.js` | queue depth / async volume |

Both are stateless (all state in Mongo/Redis), so both scale horizontally behind the platform's load balancer.

```
        ┌──────────── Load Balancer (sticky for WS) ─────────────┐
        │                                                        │
   api x N ────────────────┐                    ┌──────── worker x M
        │                  ▼                    ▼                │
        └────► Redis (cache + pub/sub + BullMQ + socket adapter) ┘
                 │                    │
            MongoDB Atlas        Stripe / KYC / R2 / Twilio / FCM / Postmark
            (replica set)
```

---

## 3. Environments

| Env | Purpose | Data | Stripe |
|---|---|---|---|
| **dev** | Local + shared dev | Local docker-compose (Mongo replica set, Redis, Mailhog) or a dev Atlas/Upstash | test mode |
| **staging** | Pre-prod, **mirrors prod for payment + geospatial paths** | Separate Atlas + Upstash | test mode |
| **production** | Pilot (Modesto) | Atlas (prod cluster) + Upstash (prod) | live mode |

The docs specifically require staging to mirror prod for the **payment and geospatial** paths — the hardest to safely test only in production. Env separation is strict; no shared secrets across envs.

---

## 4. Hosting Choices (pilot)

| Component | Choice | Notes |
|---|---|---|
| API + worker | **Render / Railway / Fly.io** | Containerized, long-lived, autoscale, health-checked |
| MongoDB | **MongoDB Atlas** | Replica set (required for transactions), managed backups, encryption at rest |
| Redis | **Upstash** (or platform Redis) | Cache + pub/sub + BullMQ + socket adapter |
| Object storage | **Cloudflare R2** + CDN | No egress fees |
| DNS/edge | Cloudflare | TLS, WAF, rate-limit edge assist |

Managed over self-hosted everywhere — "operational-risk reduction beats marginal cost at pilot scale" (docs).

> **Frontend** (Next.js PWA + React dashboards) deploys separately on Vercel/Netlify and talks to this backend over HTTPS + WSS. Keeping the persistent backend separate from Next is what avoids the serverless-WebSocket trap (docs §0).

---

## 5. Containerization

- **Multi-stage Dockerfile:** build (tsc) → slim runtime (node:20-alpine, non-root user, only `dist/` + prod deps).
- Health probes: `/healthz` (liveness), `/readyz` (readiness — Mongo/Redis/Stripe reachability).
- Graceful shutdown on SIGTERM: stop accepting connections, drain in-flight requests + jobs, close Mongo/Redis, then exit (platform then rolls the next instance).
- `.dockerignore` excludes tests, docs, secrets. No secrets baked into images.

---

## 6. CI/CD (GitHub Actions)

Pipeline stages:
1. **Install + typecheck** (`tsc --noEmit`, strict).
2. **Lint** (ESLint incl. `no-floating-promises`, import-boundary rule) + format check.
3. **Unit tests** (Vitest/Jest).
4. **Integration tests** (Supertest + `mongodb-memory-server` in **replica-set mode** so transactions run + ioredis-mock).
5. **Security gates:** dependency scan (fail on high severity), secret scan (gitleaks), the **authorization test suite** (A01 — merge gate for money-movement changes).
6. **Build image** → push to registry.
7. **Migrate** (`migrate-mongo up`) against the target env (indexes, seeds) — run before app rollout.
8. **Deploy** to staging → smoke tests (health, a payment test-mode flow, a geo nearby query) → **manual promote** to production.

Branch strategy: trunk-based with short-lived feature branches; PRs require green CI + review. Prod deploys are tagged/versioned for rollback.

---

## 7. Data & Migrations

- **`migrate-mongo`** scripts version indexes, enum/seed data (curated category taxonomy ~15–25, cities, initial fee schedule), and backfills. MongoDB is schemaless at the engine level, so **indexes and seeds are explicit, reviewed, environment-promoted migrations** — never implicit runtime `ensureIndex` in prod.
- **Backups:** Atlas continuous backups + point-in-time recovery; periodic restore drills.
- **Retention jobs** (30-day location purge, Q7) run in the worker (see [BACKGROUND_JOBS.md](BACKGROUND_JOBS.md)).
- **Zero-downtime schema evolution:** additive changes + `schema_version` field + backfill jobs; never a destructive in-place change on live financial data.

---

## 8. Release Practice

- **Rolling deploys** with readiness gating (no traffic to an instance until `/readyz` passes).
- **Migrations run before code** that depends on them; migrations are backward-compatible with the currently-running version (expand/contract pattern).
- **Feature flags + city scoping:** new features and the consignment layer are gated per city (`cities.feature_flags`), so launch scope is a config toggle, not a redeploy. Consignment layer gated to launch cities where hub partnerships + legal review are complete (Exec §7 recommendation).
- **Rollback:** redeploy the previous image tag; migrations designed to be forward-compatible so a rollback doesn't strand data.

---

## 9. Pilot-Launch Readiness (Modesto)

Per Milestone 7:
- **Load test** the realtime + geospatial paths (target 10k concurrent live sessions/metro) with baseline metrics captured for alerting.
- Staged rollout (internal → hand-onboarded pilot vendors → public).
- Sponsor integration (Wonder Ice — UTM links + manual reporting for pilot, Q9).
- Monitoring/alerting live before public traffic (dashboards + page-level alerts from [LOGGING_AND_MONITORING.md](LOGGING_AND_MONITORING.md)).
- Stripe in **live mode** only after test-mode staging sign-off on the full settlement path.

---

## 10. Path to Scale (post-pilot, deliberately deferred)
- Read replicas / secondary read-preference for dashboards as read load grows.
- Consider sharding (shard key `city_id`/geohash chosen now) only when a single cluster is stressed.
- Extract the **AI/recommendation Python (FastAPI) microservice** once real data justifies ML — the module boundary is already drawn (see [MODULE_BREAKDOWN.md](MODULE_BREAKDOWN.md) §14).
- Migrate to AWS ECS/EKS only when traffic/cost warrants — not before.
