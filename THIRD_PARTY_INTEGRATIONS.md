# StreetServe — Third-Party Integrations

> Every external dependency, its responsibility, the adapter boundary, failure handling, and webhook surface.
> Principle: **every third party sits behind an internal adapter interface** (`src/integrations/*`) so it is swappable and mockable. The brief names several as "X or Y" (Clerk/Auth0, Stripe Identity/Persona) — the adapter is what makes that a one-file choice.
> Companion: [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md) §6, [API_SPECIFICATION.md](API_SPECIFICATION.md) §15.

---

## 1. Integration Map

| Concern | Provider | Adapter | System of record? |
|---|---|---|---|
| Auth / identity / sessions | **Clerk** (primary) / Auth0 | `integrations/auth` | Provider owns credentials; we own roles |
| KYC (ID + liveness) | **Stripe Identity** (primary) / Persona | `integrations/kyc` | Provider owns documents; we store reference+status |
| Payments / payouts / escrow | **Stripe Connect** (+ Stripe Tax) | `integrations/stripe` | **Stripe authoritative for money** |
| Object storage | **Cloudflare R2** (S3-compatible) | `integrations/storage` | R2 owns blobs; we store URLs |
| SMS / OTP bridge | **Twilio** | `integrations/sms` | — |
| Push | **Firebase Cloud Messaging** | `integrations/push` | — |
| Email (transactional) | **Postmark** (or SES) | `integrations/email` | — |
| Maps (client-side) | Mapbox/MapLibre | *(frontend)* | geocoding/tiles server-side only if needed |

---

## 2. Auth (Clerk / Auth0)

- **Responsibility:** registration, OTP, login, password reset, brute-force protection, session/token issuance.
- **Backend usage:** verify JWT via **JWKS** at the API edge (cached, rotated); no shared secret. Sync users via `/webhooks/clerk` (create/update/delete) + JIT upsert on first authenticated request.
- **Boundary:** `integrations/auth` exposes `verifyToken(jwt) → { subject, claims }` and `syncUser(event)`. Swapping Clerk↔Auth0 touches only this adapter + JWKS config.
- **Failure:** JWKS fetch failure → serve from cache; if no cache and can't fetch → 503 (fail closed on auth). Provider outage degrades *new logins*, not existing valid tokens until expiry.

## 3. KYC (Stripe Identity / Persona)

- **Responsibility:** government-ID capture + selfie liveness, tied to Bronze/Silver tiers.
- **Flow:** `POST /verification/id-document` creates a provider verification session → returns a hosted-flow URL/token → user completes → provider fires `/webhooks/kyc` → we update `verification_records.status` + tier → notify user (socket/push).
- **Storage:** we persist **only** `provider`, `provider_reference`, `status`, `verified_at`. Never the raw document (Security §2, Q7).
- **Failure/rejection:** rejected check → clear reason surfaced, user stays at current tier, resubmit allowed. Provider down → submission queued `pending`, tier unchanged (fail closed on capability).
- **Boundary:** `integrations/kyc` interface `createSession(userId, type)`, `parseWebhook(payload,sig)` — Stripe Identity ↔ Persona swap is adapter-local.

## 4. Payments (Stripe Connect + Stripe Tax) — the money boundary

The single most important integration. **Stripe is authoritative for balances; we never build a custom ledger.**

- **Connected accounts:** each vendor/seller/hub onboards a Stripe Connect account (Express/Custom) via hosted onboarding (`/verification/bank-account`). We store `payout_account_ref`.
- **Charges:** PaymentIntents via Stripe Elements/Payment Element (card + Apple/Google Pay via Payment Request API). No raw card data on our servers (PCI SAQ A).
- **Splits & payouts:** `transfer`/`transfer_data` for platform-fee / hub-share / seller-net splits; **tiered payout timing** (Bronze 3d hold / Silver next-day / Gold instant, FR-11.2) via delayed payouts / hold logic.
- **Round-up:** 100% to vendor, platform cut 0 (FR-6.4).
- **Tax:** Stripe Tax computes/collects/remits marketplace-facilitator sales tax centrally (Q3).
- **Idempotency:** Stripe idempotency keys on every money call; our `Idempotency-Key` header maps through.
- **Account hygiene:** a **fresh** Connect account with **accurate marketplace category** (Q5) — the explicit counter to the excluded-chat misrepresentation pattern. No workarounds around compliance review.
- **Webhooks (`/webhooks/stripe`):** signature-verified, **raw body**, dedupe by event id. Handle `payment_intent.succeeded/failed`, `transfer.*`, `payout.*`, `charge.dispute.*`, `account.updated`, tax events → reconcile the ledger mirror.
- **Reconciliation:** nightly job diffs mirror vs Stripe; drift → ops/fraud flag.
- **Failure:** transient Stripe errors → idempotent retry with backoff (financial jobs, conservative). Webhook lag is expected — statuses are eventually consistent; client polls/receives socket update.
- **Boundary:** `integrations/stripe` wraps all of the above; the rest of the app calls domain-shaped methods (`chargeCustomer`, `settleAndPayout`, `refund`, `payTip`), never the Stripe SDK directly.

## 5. Object Storage (Cloudflare R2)

- **Responsibility:** condition photos (checkout/return), product/menu/profile photos, dispute evidence.
- **Upload pattern:** **presigned PUT URLs** — client uploads directly to R2, server never proxies bytes. Server validates content-type + size, stores the resulting URL.
- **Access:** private buckets + signed GET URLs for sensitive media (dispute evidence, condition photos); public-read (behind CDN) for menu/product/logo images.
- **Why R2:** no egress fees (docs) given the photo-heavy flows.
- **Failure:** presign failure → 503 on that upload; the domain action (e.g., checkout) requires the photo, so it fails closed rather than proceeding photoless.

## 6. SMS (Twilio)

- **Responsibility:** OTP delivery (if not provider-hosted) and — critically — the **reliable alert bridge** for the four background-blocked interactions (proximity, Block Party, geofence check-in, vendor-pin-while-locked) that the PWA can't do while the phone sleeps (docs §12). SMS fires regardless of app state.
- **Guardrails:** rate-limited; opt-in/opt-out (STOP) honored; templated messages; no PII beyond necessity.
- **Failure:** delivery failure → fall back to push/email; log for the notification audit.

## 7. Push (FCM)

- **Responsibility:** web push (PWA, Android solid / iOS when installed) and future native push.
- **Token management:** device tokens per user; prune invalid tokens on send failure.
- **Failure:** FCM error → SMS/email fallback for safety-critical categories.

## 8. Email (Postmark / SES)

- **Responsibility:** transactional only — receipts, verification results, dispute updates, payout confirmations, safety-critical notices that were muted in-app (redirected to email, Flow 12).
- **Failure:** provider down → retry via job queue; safety-critical emails are high-priority in the notifications queue.

---

## 9. Cross-Cutting Integration Rules

- **Adapter isolation:** no third-party SDK imported outside its `integrations/*` folder. Enforced by lint boundary rule.
- **Resilience on every outbound call:** timeout + retry-with-jitter + **circuit breaker**; a failing third party trips the breaker and degrades gracefully rather than cascading.
- **Idempotency:** all money and notification calls idempotent; safe under retry.
- **Webhook security:** every inbound webhook is signature-verified on the **raw body**, deduped by event id, and processed idempotently. Webhook routes are exempt from bearer auth but not from verification.
- **Secrets:** all provider keys in the platform secret store, per-environment, rotated; test keys in dev/staging (Stripe test mode).
- **Observability:** each adapter emits metrics (latency, error rate, breaker state) and structured logs with correlation IDs.
- **Sandbox parity:** staging mirrors prod for Stripe + KYC + storage specifically (the hardest-to-test-in-prod paths).

## 10. Environment Variables (representative)
```
CLERK_JWKS_URL / CLERK_SECRET_KEY
STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_CONNECT_CLIENT_ID
STRIPE_IDENTITY_* (or PERSONA_API_KEY / PERSONA_WEBHOOK_SECRET)
R2_ACCOUNT_ID / R2_ACCESS_KEY / R2_SECRET / R2_BUCKET_*
TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_MESSAGING_SID
FCM_PROJECT_ID / FCM_SERVICE_ACCOUNT_JSON
POSTMARK_SERVER_TOKEN
MONGODB_URI (replica set) / REDIS_URL
```
All validated at boot by `config/env.ts` (Zod) — the process fails fast if any required secret is missing or malformed.
