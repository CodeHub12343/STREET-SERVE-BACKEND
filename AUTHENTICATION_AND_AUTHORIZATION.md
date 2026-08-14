# StreetServe — Authentication & Authorization

> How identity, sessions, the 9-role additive model, verification tiers, and resource-level permissions work.
> The docs flag **broken access control** as "the single highest-risk area for this specific product." This document is written to that risk.
> Companion: [SECURITY_GUIDELINES.md](SECURITY_GUIDELINES.md), [API_SPECIFICATION.md](API_SPECIFICATION.md).

---

## 1. Authentication (who you are)

**Managed provider: Clerk (primary) or Auth0.** We do not build credential storage, OTP, brute-force protection, or session management — the docs are explicit this is "a distraction at pilot stage."

### Token model
- **Access token:** provider-issued JWT, short-lived (~15 min), sent as `Authorization: Bearer`.
- **Refresh token:** long-lived, rotated on use, stored httpOnly (web) / secure storage (native). Revocable on logout and on suspicious-activity detection.
- **Verification at the edge:** the API verifies the JWT signature against the provider's **JWKS** (cached, rotated), checks `iss`/`aud`/`exp`, and extracts the subject. No shared secret; no DB hit on the hot path.

### User sync
- On first authenticated request (JIT) **and** via `/webhooks/clerk` lifecycle events, we upsert a local `users` row keyed by `authProviderId`. Local row holds app-domain data (roles, home location, precision prefs); the provider holds credentials.
- OTP (register/login) and password reset are provider-hosted flows. `/auth/register`, `/auth/verify-otp`, `/auth/login` in the API spec are thin proxies where the provider allows, or are replaced by the provider's hosted UI + our post-auth `/auth/roles` and verification calls.

### The Principal
Every authenticated request resolves a `Principal` attached to request context:
```ts
interface Principal {
  userId: string;
  authProviderId: string;
  roles: Role[];                 // from user_roles (not from the token claims)
  verificationTier: 'tier0'|'bronze'|'silver'|'gold';
  status: 'active'|'suspended';
  cityId?: string;
}
```
> **Roles come from our DB, not the JWT.** The token proves identity; capabilities are our authority. This prevents a stale/forged claim from granting a role.

---

## 2. Authorization (what you may do)

Three layers, all enforced **server-side, on every non-public route**. Never trust a client-declared role.

### Layer 1 — Role (coarse)
Additive multi-role model on one identity — roles are capabilities, not account types (docs §Roles, Design rule). A single account can be customer + seller + vendor simultaneously; trust/history carries forward.

| Role | Grants |
|---|---|
| `guest` (unauthenticated) | Public map (approximate pins), public listings, public profiles |
| `customer` (default) | Wave-down, queue, order, book, gift, Spot Me request, round-up, review, follow, message |
| `seller` | Reserve/checkout inventory, log sales, returns, payouts, AI assistant, Jobs |
| `vendor` | Live broadcast, queue/discount config, Pop-Up, ping budget, menu, vendor dashboard, Spot Me terms |
| `hub` | Product upload, consignment terms, hub locations, approve seller checkouts, business dashboard |
| `shelter_admin` | Verify residents, cosign allocations, aggregate reporting |
| `sponsor` | Logo placement, sponsor reporting (no transactional access) |
| `admin` (Trust & Safety) | Full read, dispute arbitration, suspension, fraud review, category/license metadata, payout holds |
| `ops_finance` | Payout config, fee schedule, sponsor billing, reconciliation (least-privilege) |

Middleware: `requireRole('vendor')`, `requireAnyRole('vendor','admin')`.

### Layer 2 — Resource ownership (fine)
Role alone is insufficient. The docs' canonical example: *"seller A cannot settle seller B's checkout."* Every resource-scoped route runs an **ownership check** after the role check:
```ts
requireOwnership(async (principal, params) => {
  const checkout = await consignment.getCheckout(params.id);
  return checkout.seller_id === principal.userId; // or hub owner for hub-side actions
});
```
Ownership patterns:
- Seller acts only on **their own** checkouts/sales/returns.
- Hub owner approves checkouts only for **their own** products.
- Vendor mutates only **their own** business/menu/queue/live-session/ping-budget.
- Message participants only within **their own** thread.
- Dispute evidence only by a **party** to the dispute; resolution only by `admin`.

### Layer 3 — Verification tier (capability gate)
Tier gates *what a role can do*, independent of role membership. The tiered model is itself a **security control**, not just UX (docs OWASP §6 "insecure design") — any "skip verification to grow faster" proposal is a security regression requiring sign-off.

| Tier | Unlocked | Payout timing |
|---|---|---|
| Tier 0 (Browse) | View inventory; cannot check out | — |
| Bronze | Gov ID + selfie liveness → low-value checkout | Held 3 days |
| Silver | Bank linked (Stripe Connect) → standard limits | Next business day |
| Gold | Sustained trust threshold → premium inventory, higher split | Instant |
| Shelter path | Shelter cosign → Tier-1-equivalent without prior ID/bank history | Held (capped allocation) |

Gate example: `POST /checkouts` requires `tier ≥ bronze`; premium products require `tier = gold`. Verification is **portable across roles** (Q10) — a verified seller who becomes a vendor does not redo ID/liveness.

---

## 3. Enforcement Mechanics

- **Guard composition on every route:** `[authenticate] → [requireRole/AnyRole] → [requireOwnership?] → [requireTier?] → [validate] → controller`.
- **Deny by default:** routes are non-public unless explicitly marked. A route with no guard is a lint/review failure.
- **Central permission matrix:** a single `permissions.ts` maps `(action) → (roles, tier, ownership-resolver)`, so authorization is declarative and auditable, not scattered through controllers.
- **Automated authorization tests are mandatory** (docs OWASP §6): for every money-movement and cross-user action, a test asserts "actor without the right role/ownership/tier gets 403" — invest disproportionately here.
- **Admin sub-tiers:** `admin` (T&S: disputes, suspensions, fraud) vs `ops_finance` (payouts, fees, reconciliation) are distinct roles; neither is a superset by default (separation of duties on money).

---

## 4. Session & Token Security

- Short access-token lifetime limits blast radius of a leaked token.
- Refresh-token **rotation** with reuse-detection (a replayed old refresh token invalidates the whole chain).
- Revocation on logout and on admin suspension (a suspended `users.status` fails the auth guard immediately, even with a valid token, because the Principal load checks status).
- Socket.IO handshake authenticates the same JWT and re-checks status + room authorization (see [REALTIME_ARCHITECTURE.md](REALTIME_ARCHITECTURE.md)).

---

## 5. Identity Verification (KYC) — distinct from login

- Separate concern from auth: **Stripe Identity (primary) or Persona** hosted web flow.
- StreetServe stores **only a provider reference + status**, never raw ID/selfie documents (Security §2, Q7) — minimizes breach/CCPA blast radius.
- Async lifecycle: submit → `pending` → provider webhook → tier update → user notified. Fail closed: an unresolved check keeps the user at current tier.

---

## 6. Audit of Authorization-Sensitive Events

Every one of these writes an immutable `audit_logs` entry (actor, timestamp, reason):
- Role grant/revoke, admin role elevation.
- Verification tier change.
- Payout hold/release, fee-schedule change.
- Dispute resolution, account suspension.
- Any admin action on another user's resource.

Alerting fires on anomalies (e.g., spike in role elevations, Spot Me from new accounts) per [LOGGING_AND_MONITORING.md](LOGGING_AND_MONITORING.md).

---

## 7. Authorization Threat Checklist (build-time)
- [ ] Every non-public route has an explicit role guard.
- [ ] Every resource-scoped route has an ownership resolver.
- [ ] Money/inventory routes additionally check tier.
- [ ] Roles are read from DB, never trusted from the token/body.
- [ ] Admin and finance are separate roles (separation of duties).
- [ ] Automated "wrong actor → 403" tests exist for all cross-user + money actions.
- [ ] Suspended accounts are rejected at the Principal load, even with a valid token.
