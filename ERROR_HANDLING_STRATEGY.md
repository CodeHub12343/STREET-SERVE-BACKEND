# StreetServe — Error Handling Strategy

> One error model, one envelope, one place errors become HTTP responses. Consistency here is what makes the client, the logs, and the on-call experience sane.
> Companion: [API_SPECIFICATION.md](API_SPECIFICATION.md) §0, [VALIDATION_RULES.md](VALIDATION_RULES.md), [LOGGING_AND_MONITORING.md](LOGGING_AND_MONITORING.md).

---

## 1. Error Envelope (platform-wide)

```jsonc
{ "error": {
    "code": "STRING_CODE",       // stable machine code from the registry
    "message": "human readable",  // safe to show; no internals/stack/secrets
    "details": { ... },           // optional: field errors, conflicting ids
    "requestId": "req_...",       // for support correlation
    "retryable": false            // hint for the client
} }
```

- `code` is a **stable contract** — clients branch on it; never repurpose a code's meaning.
- `message` is user-safe; internal detail lives only in logs (keyed by `requestId`).
- HTTP status matches semantics (see §3).

---

## 2. AppError Hierarchy

A single base error type carries the code + status; the final middleware serializes it. Anything thrown that isn't an `AppError` is treated as an unexpected `500` (logged with stack, generic message to client).

```ts
class AppError extends Error {
  code: string; httpStatus: number; details?: unknown;
  retryable = false; expose = true;      // expose=false → generic message to client
}
// specializations set status + default code:
ValidationError(400) · UnauthenticatedError(401) · ForbiddenError(403)
NotFoundError(404) · ConflictError(409) · BusinessRuleError(422)
RateLimitError(429) · UpstreamError(502) · UnavailableError(503)
```

Services throw domain errors (`throw new ConflictError('OVERSELL', ...)`); controllers don't build error responses by hand.

---

## 3. Status Code Mapping (canonical)

| Status | When | Example codes |
|---|---|---|
| 400 | Request shape/type/format invalid (Zod) | `VALIDATION_ERROR` |
| 401 | Missing/invalid/expired token | `UNAUTHENTICATED`, `TOKEN_EXPIRED` |
| 403 | Authenticated but not allowed (role/ownership/tier) | `FORBIDDEN`, `TIER_TOO_LOW` |
| 404 | Resource not found (or hidden for privacy) | `NOT_FOUND` |
| 409 | Conflict / concurrency / state | `OVERSELL`, `INVALID_STATE_TRANSITION`, `DUPLICATE` |
| 422 | Business-rule violation on a well-formed request | `SPOT_ME_INELIGIBLE`, `LICENSE_REQUIRED`, `AGREEMENT_REQUIRED`, `BUSINESS_AWAY` |
| 429 | Rate-limited | `RATE_LIMITED`, `PAID_SHARE_CAP_REACHED` |
| 500 | Unexpected/unhandled | `INTERNAL_ERROR` |
| 502/503 | Upstream (Stripe/KYC/etc.) failing or degraded | `UPSTREAM_ERROR`, `SERVICE_UNAVAILABLE` |

**409 vs 422 rule:** 409 = concurrency/state collision (retry might succeed after refetch); 422 = a rule that will keep failing until the client changes something. This distinction matters to the mobile client's retry logic.

---

## 4. Error Code Registry (representative)

Codes live in one file (`shared/errors/codes.ts`), grouped by domain, so they're discoverable and non-colliding.

| Domain | Codes |
|---|---|
| Auth | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `OTP_INVALID`, `OTP_LOCKOUT` |
| Authz | `FORBIDDEN`, `NOT_OWNER`, `TIER_TOO_LOW`, `ROLE_REQUIRED` |
| Validation | `VALIDATION_ERROR`, `UNKNOWN_FIELD` |
| Live/Queue | `NO_ACTIVE_SESSION`, `LICENSE_REQUIRED`, `WAVE_EXPIRED`, `QUEUE_CLOSED` |
| Orders | `BUSINESS_AWAY`, `ITEM_UNAVAILABLE`, `INVALID_STATE_TRANSITION` |
| Payments | `PAYMENT_FAILED`, `IDEMPOTENCY_CONFLICT`, `PAYOUT_HELD` |
| Consignment | `OVERSELL`, `AGREEMENT_REQUIRED`, `RETURN_WINDOW_CLOSED`, `LISTING_TYPE_UNSUPPORTED` (A-1 — a listing type with no settlement path), `TRUST_TOO_LOW` (A-3 — premium stock the seller has not yet earned), `CATEGORY_NOT_PERMITTED` (A-6 — food in an uncleared jurisdiction) |
| Growth | `SPOT_ME_INELIGIBLE`, `PAID_SHARE_CAP_REACHED`, `GIFT_EXPIRED`, `GIVEAWAY_CAP_REACHED` |
| Shelter program | `PARTNER_NOT_VERIFIED`, `ALLOCATION_EXCEEDED` (B-2 — over the shelter's cosigned cap, not the tier limit), `TRAINING_REQUIRED` (B-5 — starter course not passed) |
| Academy | `CERTIFICATION_REQUIRED` (D-5 — product gated on an Academy certification the seller doesn't hold; the message names the course, because this lock is clearable today), `PAYMENT_REQUIRED` (F-5 — `422` on submitting a paid certification exam that hasn't been bought; the course *material* is never gated, only the credential) |
| Disputes | `DISPUTE_NOT_PARTICIPANT`, `ALREADY_RESOLVED` |
| Rate/Upstream | `RATE_LIMITED`, `UPSTREAM_ERROR`, `SERVICE_UNAVAILABLE` |

---

## 5. Handling Rules

- **One error middleware, mounted last.** It is the only place an error becomes an HTTP response. It: picks status/code, logs at the right level, strips internals when `expose=false`, attaches `requestId`.
- **No control flow via exceptions across module boundaries** for expected outcomes that aren't errors — but genuine rule violations (oversell, ineligible) *are* thrown as typed `AppError`s and mapped, not returned as `{ok:false}` ad hoc.
- **Never leak internals:** stack traces, Mongo errors, Stripe raw errors, secrets never reach the client. Mongo duplicate-key (E11000) → `409 DUPLICATE`; Mongo validation → `400`; cast errors → `400`.
- **Money paths fail closed:** on ambiguity, do not complete the money move; surface a retryable error and rely on idempotency so the client can safely retry.
- **Idempotency conflicts:** a reused `Idempotency-Key` with a *different* body → `409 IDEMPOTENCY_CONFLICT`; same body → return the cached original response (not an error).
- **Validation errors** return `details.fieldErrors` (path → message) so the client can highlight fields.

---

## 6. Async, Jobs & Sockets

- **No floating promises** (lint-enforced); every async route is wrapped so rejections reach the error middleware.
- **BullMQ jobs:** typed errors → retry/backoff per policy; financial jobs use conservative retry + DLQ + on-call page (see [BACKGROUND_JOBS.md](BACKGROUND_JOBS.md) §5). A job never silently swallows a money error.
- **Socket handlers:** wrapped so a thrown error emits a structured `error` event to that socket (same envelope shape) and is logged — never crashes the connection or the process.
- **Unhandled rejections / uncaught exceptions:** logged fatally, then **graceful shutdown** (stop accepting new work, drain in-flight, close Mongo/Redis) — the process exits and the platform restarts it, rather than running in an unknown state.

---

## 7. Client Contract & Retry Guidance

- `retryable: true` on 429/502/503 and transient 409s → client backs off and retries (with the same Idempotency-Key on money calls).
- `retryable: false` on 4xx business rules → client must change the request, not retry.
- Token expiry (`401 TOKEN_EXPIRED`) → client silently refreshes and retries once.
- Every error carries `requestId` so a user can quote it to support and on-call can find the exact log line.

---

## 8. Testing
- Unit tests assert the correct `AppError` subtype/code for each rule violation.
- Integration tests assert the HTTP status + envelope + code for representative failures (oversell → 409 OVERSELL, spot-me under 30 days → 422 SPOT_ME_INELIGIBLE, wrong-owner settle → 403).
- A contract test guarantees every thrown code exists in the registry and maps to a status (no orphan/undocumented codes).
