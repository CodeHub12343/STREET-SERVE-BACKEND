# Environment Setup — filling in `.env`

This guide explains **where each value in `.env` comes from** and how to get the
app running locally. It maps directly to `.env.example` and to what the config
loader (`src/config/env.ts`) actually validates at boot.

## TL;DR — the minimum to boot

The server **fails fast** on startup if these are missing (see `src/config/env.ts`):

| Variable | Required when | Notes |
| --- | --- | --- |
| `MONGODB_URI` | **Always** | Must be a **replica set** (transactions need it). |
| `AUTH_JWKS_URL` | `NODE_ENV` ≠ `test` | From Clerk/Auth0. |
| `AUTH_ISSUER` | `NODE_ENV` ≠ `test` | From Clerk/Auth0. |
| `AUTH_AUDIENCE` | `NODE_ENV` ≠ `test` | You choose this string. |

Everything else either has a sane default or is **optional** — the app boots
without Stripe, R2, or KYC keys. Those subsystems only throw *if you actually
invoke them* (create a payment, request a presigned upload, etc.). So for a
first run you only need **MongoDB + Clerk**.

---

## Step 0 — Prerequisites

- **Node 20.x** (`package.json` pins `>=20 <21`). Check: `node -v`.
- **Docker Desktop** (easiest way to get Mongo + Redis locally).

Then:

```bash
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
npm install
```

---

## Step 1 — Datastores (Docker) → `MONGODB_URI`, `REDIS_URL`

The repo ships a `docker-compose.yml` that runs everything you need:

```bash
docker compose up -d
```

This starts:
- **MongoDB 7** as a single-node replica set `rs0` (it self-initialises via the
  healthcheck — no manual `rs.initiate()` needed).
- **Redis 7** (used by BullMQ jobs + the Socket.IO adapter).
- **Mailhog** — catch-all SMTP with a UI at http://localhost:8025.

The default values in `.env.example` already match this compose file, so you can
leave them as-is:

```dotenv
MONGODB_URI=mongodb://localhost:27017/streetserve?replicaSet=rs0&directConnection=true
REDIS_URL=redis://localhost:6379
```

> **Not using Docker?** You must run Mongo as a replica set yourself
> (`mongod --replSet rs0` then `rs.initiate()`), otherwise multi-document
> transactions fail. `REDIS_URL` is optional but recommended.

**Verify Mongo is up:**
```bash
docker compose ps
docker compose logs mongo --tail=20
```

---

## Step 2 — Managed Auth (Clerk) → `AUTH_*`

The API verifies user tokens at the edge using the provider's **JWKS** (public
keys). You do **not** put any private signing key here. Default provider is
`clerk`.

### Get the values from Clerk (free tier is fine)

1. Create an account at https://dashboard.clerk.com and create an **Application**.
2. In the app dashboard, note your **Frontend API / instance domain**. It looks
   like `your-tenant.clerk.accounts.dev`.
3. Fill in:

```dotenv
AUTH_PROVIDER=clerk
AUTH_JWKS_URL=https://your-tenant.clerk.accounts.dev/.well-known/jwks.json
AUTH_ISSUER=https://your-tenant.clerk.accounts.dev
AUTH_AUDIENCE=streetserve-api
```

- **`AUTH_JWKS_URL`** — always `https://<your-clerk-domain>/.well-known/jwks.json`.
  Open it in a browser to confirm it returns a JSON key set.
- **`AUTH_ISSUER`** — the `iss` claim Clerk stamps on tokens. For most Clerk
  instances this is the same `https://<your-clerk-domain>` value. (Confirm by
  decoding a real session token at https://jwt.io and reading its `iss`.)
- **`AUTH_AUDIENCE`** — a string **you** define. Set it here and configure Clerk
  to include the same `aud` in issued tokens (JWT Templates), or coordinate with
  the frontend. `streetserve-api` is a fine default.

### `AUTH_WEBHOOK_SECRET`

Used to verify inbound **user-sync webhooks** (Clerk → your API keeps the local
user copy in sync). Get it when you create the webhook endpoint:

1. Clerk Dashboard → **Webhooks** → add an endpoint pointing at your API's
   auth-webhook route (e.g. `https://<your-api>/webhooks/auth`; for local dev
   tunnel it with `ngrok`).
2. Copy the **Signing Secret** (starts with `whsec_`).

```dotenv
AUTH_WEBHOOK_SECRET=whsec_...
```

Optional for a first boot — only needed once you exercise the webhook.

> Using **Auth0** instead? Set `AUTH_PROVIDER=auth0`, point `AUTH_JWKS_URL` at
> `https://<tenant>.auth0.com/.well-known/jwks.json`, `AUTH_ISSUER` at
> `https://<tenant>.auth0.com/`, and `AUTH_AUDIENCE` at your API Identifier.

---

## Step 3 — Core / CORS (defaults are fine)

```dotenv
NODE_ENV=development
PORT=8080
LOG_LEVEL=debug
CORS_ORIGINS=http://localhost:3000   # comma-separated; add your frontend origin(s)
```

`CORS_ORIGINS` must include wherever the frontend runs. The Next.js frontend
defaults to `http://localhost:3000`, which is already listed.

---

## Step 4 — Optional integrations (skip for first run)

These are all optional at boot. Add them only when you need that feature.

### Payments — Stripe Connect + Stripe Tax

Needed to move real money. Tests inject a fake gateway, so leave as placeholders
until you work on payments.

1. Create a Stripe account → https://dashboard.stripe.com
2. **Developers → API keys** → copy the **Secret key** (`sk_test_...` in test mode).
3. **Developers → Webhooks** → add an endpoint → copy its **Signing secret**
   (`whsec_...`).

```dotenv
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CONNECT_COUNTRY=US
PLATFORM_CURRENCY=usd
STRIPE_TAX_ENABLED=false        # set true only after enabling Stripe Tax
```

### KYC — Stripe Identity (default) or Persona

```dotenv
KYC_PROVIDER=stripe_identity
KYC_WEBHOOK_SECRET=...          # Stripe Identity uses your Stripe webhook secret; Persona has its own
KYC_RETURN_URL=http://localhost:3000/verify/complete
CONNECT_RETURN_URL=http://localhost:3000/payouts/complete
CONNECT_REFRESH_URL=http://localhost:3000/payouts/refresh
```

The three URLs are where users land after verification / Connect onboarding.
The defaults point at the local frontend and are fine for dev.

### Object storage — Cloudflare R2 (or any S3-compatible)

Needed for real presigned media uploads; tests inject a fake.

1. Cloudflare Dashboard → **R2** → create a bucket (e.g. `streetserve-media`).
2. **Manage R2 API Tokens** → create a token → copy **Access Key ID** and
   **Secret Access Key**.
3. Your endpoint is `https://<account-id>.r2.cloudflarestorage.com`.
4. `R2_PUBLIC_BASE_URL` is your bucket's public/CDN domain.

```dotenv
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=streetserve-media
R2_PUBLIC_BASE_URL=https://cdn.example.com
R2_REGION=auto
```

### AI provider — Google Gemini

Powers the wording of seller recommendations (`/ai/*`) and sales coaching.

```dotenv
AI_PROVIDER=gemini
GEMINI_API_KEY=AIza...            # https://aistudio.google.com/apikey
GEMINI_MODEL=gemini-2.5-flash     # free tier; gemini-2.5-pro once billing is on
GEMINI_FAST_MODEL=gemini-2.5-flash-lite
GEMINI_TIMEOUT_MS=6000
```

**Leaving this blank is a supported configuration.** With no key (or
`AI_PROVIDER=rule_based`) the AI module runs the deterministic rule-based
engine, which is complete on its own — you lose the generated wording, not the
feature. The active engine is printed at boot as `aiProvider` in the
`streetserve api listening` line.

Gemini never chooses products, ranks hubs, or sets prices — those come from
scoring real sales data, so a suggestion is always traceable to the signals in
its `factors` array. Gemini only writes the human-readable explanation of what
that scoring already decided. Every call fails open to the deterministic copy on
timeout, quota exhaustion, or an unusable reply.

Tests always use the rule-based engine regardless of this config, so the suite
never depends on a live model.

### Toggles / scoping (defaults fine)

```dotenv
RATE_LIMIT_ENABLED=true
METRICS_ENABLED=true
OPENAPI_ENABLED=true
DEFAULT_CITY=modesto-ca
```

---

## Step 5 — Run the app

```bash
# 1. datastores
docker compose up -d

# 2. database migrations + seed reference data
npm run migrate:up
npm run seed            # optional, seeds reference/sample data

# 3. API server (http://localhost:8080)
npm run dev

# 4. background worker (separate terminal) — needs REDIS_URL
npm run dev:worker
```

**Sanity checks:**
- Health: http://localhost:8080/health (see `src/modules/health`)
- OpenAPI docs: served when `OPENAPI_ENABLED=true`
- Metrics: served when `METRICS_ENABLED=true`

If the process exits immediately on startup, read the `[config]` error it
prints — the loader lists exactly which variable is missing or invalid.

---

## What can I safely leave blank on day one?

| Group | Blank OK at boot? | Blocks which feature |
| --- | --- | --- |
| `MONGODB_URI` | ❌ no | everything |
| `AUTH_*` (JWKS/ISSUER/AUDIENCE) | ❌ no (dev/prod) | all authenticated routes |
| `AUTH_WEBHOOK_SECRET` | ✅ yes | user-sync webhook |
| `REDIS_URL` | ✅ yes | jobs + realtime scale-out |
| `STRIPE_*` | ✅ yes | payments / payouts |
| `KYC_*` | ✅ yes | identity verification |
| `R2_*` | ✅ yes | media uploads |
| `GEMINI_*` | ✅ yes | AI-written copy only (rule-based engine still runs) |

> **Windows / Node PATH note:** if `npm`/`node` aren't found in the VS Code
> terminal, run the commands from a PowerShell session that has Node on `PATH`.
