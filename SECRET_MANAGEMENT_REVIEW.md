# Secret-management review

**Written 2026-08-02** (roadmap task 6.2). The 2026-08 audit marked this *"out of scope for this
audit — not assessed"*; this is the assessment.

> ### Scope, honestly
>
> This reviews **how the code handles secrets**: where they come from, whether any are committed,
> whether they can leak through logs or API responses, and whether the set is documented.
>
> It does **not** review the deployment platform — no secret-manager configuration, key rotation
> schedule, IAM policy, or CI secret storage was inspected, because none of that lives in either
> repo. Those are real questions and they are named at the end as still-open rather than blurred
> into a pass.

---

## Method

1. Enumerated every secret the app reads (the zod env schema, `src/config/env.ts`).
2. Grepped the full tree — source, tests, scripts, migrations, docs — for live-key patterns
   (`sk_live_`, `sk_test_…`, `whsec_…`, `AIza…`, PEM private keys).
3. Checked `.gitignore` in both repos against the env files that exist on disk.
4. Enumerated every `NEXT_PUBLIC_*` variable in the frontend, since all of them ship to the browser.
5. Read the log redaction list against the actual property names used by the DB layer.
6. Traced whether the hub QR signing key can reach an API response.
7. Diffed the env schema against `.env.example`.

---

## Findings

### ✅ No secret is committed, in either repo

No live-key pattern appears anywhere in tracked files. `.env` and `.env*.local` are gitignored in
both repos, and the only committed env files are `.env.example` / `.env.local.example`, which carry
`replace_me` placeholders.

### ✅ No secret is exposed to the browser

All eleven `NEXT_PUBLIC_*` variables are genuinely public: two publishable keys (Clerk, Stripe), a
Mapbox token, a VAPID **public** key, URLs, and feature flags. Nothing matching `SECRET` or `PRIVATE`
carries the prefix. This is the mistake worth checking for specifically, because Next inlines these
into the client bundle at build time and there is no runtime error when you get it wrong.

### ✅ The hub QR signing key never leaves the server

`checkout_qr_secret` is used only to *derive* the rotating token (`currentQrToken`) and to verify
one. No response body includes it. That is the Phase 6 design holding.

### ⚠️ FIXED — log redaction missed every snake_case secret

`pino`'s `*.secret` matches a property named **exactly** `secret`. It does not match
`checkout_qr_secret`. So logging a hub document — an ordinary debugging move — would have printed
the QR signing key in clear text, and that key is the entire proof of physical presence in the
custody model: whoever holds it can reserve stock without being at the hub.

The same gap applied to `access_token`, `refresh_token`, `client_secret`, `api_key`, and
`webhook_secret`: the redaction list was written in camelCase while the database layer is
snake_case, so a logged document slipped straight past it.

**Fixed** in `src/config/logger.ts` — both casings are now covered, plus `qrToken` / `qr_token`.

### ⚠️ FIXED — six environment variables were undocumented

`.env.example` documented 37 of 43 variables the app reads. The three that matter:
`CUSTOMER_SERVICE_FEE_ENABLED`, `PROCESSING_FEE_ENABLED`, and `WAVE_CONVENIENCE_FEE_ENABLED` — the
flags deciding **whether customers are charged fees at all**. An operator configuring a deployment
from `.env.example` had no way to learn they existed, which makes "the customer-facing fees are off
at launch" a fact about one developer's machine rather than a documented default.

Also missing: `APP_BASE_URL` (get it wrong and every emailed receipt and pay link points at
localhost), `WEATHER_API_KEY`, and `TICKETMASTER_API_KEY`.

**Fixed**, and guarded: `test/envDocumentation.test.ts` fails the build when the schema and
`.env.example` drift apart, and separately asserts that no real-looking key ever lands in the
example file.

### ✅ Secrets are validated at boot, not discovered at runtime

`env.ts` fails fast on missing production auth configuration and warns loudly when
`STRIPE_WEBHOOK_SECRET` is a placeholder — with the specific consequence spelled out (*"card
payments will NEVER confirm"*) rather than a generic warning. That is the right shape: a
misconfiguration that silently degrades the money path is worse than one that refuses to start.

### ✅ Request bodies are not logged

`pino-http` records request/response metadata only. A `qrToken` or card detail in a body never
reaches the log by default — which is what makes the redaction list a second line of defence rather
than the only one.

---

## Still open — needs the deployment platform, not the repo

These could not be assessed from source and should not be read as passing:

1. **Where production secrets actually live.** Environment variables on the host? A managed secret
   manager? The repos cannot tell you, and "env vars on the box" versus "AWS Secrets Manager with
   audit logging" are very different postures.
2. **Rotation.** No rotation schedule or procedure exists for `STRIPE_SECRET_KEY`,
   `AUTH_WEBHOOK_SECRET`, `KYC_WEBHOOK_SECRET`, or the R2 credentials. Nothing in the code prevents
   rotation; nothing prompts it either.
3. **CI secret handling.** Neither workflow currently consumes a secret (the build runs on
   placeholders, deliberately). The moment a deploy step is added, that changes.
4. **Per-hub `checkout_qr_secret` rotation.** It is generated once at hub registration and never
   rotated. A hub that suspects compromise has no way to re-key, only to stop accepting static
   codes — which the 6.5 phase-out now forces anyway. Worth adding a rotate endpoint before a hub
   ever needs one.
5. **Database and Redis credentials in connection strings.** `MONGO_URL` and `REDIS_URL` embed
   credentials; they are redacted from logs by URL, but not from a crash dump or a `process.env`
   listing in an error reporter, should one be added.
