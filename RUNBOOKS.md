# StreetServe — On-Call Runbooks (Phase 8)

Page-level alerts link here. Each entry: **what it means → first checks → mitigation → escalation.**
Alert thresholds are tuned against the NFRs (P95 <300ms reads / <800ms writes, 99.5% uptime).
See [LOGGING_AND_MONITORING.md](LOGGING_AND_MONITORING.md) for the metric definitions.

---

## 🔴 PAGE — Reconciliation drift (`reconciliation_drift_cents != 0`)
**Means:** our transaction ledger disagrees with Stripe's balance — money integrity risk.
1. Check the nightly `stripe-reconciliation` job log for the drift amount + direction.
2. Compare recent `transactions` (status `completed`) against the Stripe dashboard for the window.
3. Look for dead-lettered financial jobs (`financial_jobs_dead_lettered_total`) in the same window.
**Mitigation:** do NOT mass-refund. Identify the specific PaymentIntent(s); if a webhook was missed, replay it via `/webhooks/stripe`. Stripe idempotency keys make replay safe.
**Escalate:** Finance/Ops lead if drift > $50 or persists across two runs.

## 🔴 PAGE — Financial job dead-lettered (`financial_jobs_dead_lettered_total` increment)
**Means:** a settlement/payout/reconciliation job exhausted its retries and is parked in the `dead_letter` queue.
1. Inspect the `dead_letter` queue payload (`sourceQueue`, `name`, `data`, `failedReason`).
2. Check Stripe status for the referenced transfer/settlement — did the money actually move?
3. Because financial jobs are idempotent (Stripe idempotency keys), a manual re-enqueue is safe if the money did NOT move.
**Mitigation:** re-enqueue after confirming state; if the money moved but our record didn't, write an offsetting/correcting record (never mutate the immutable settlement).
**Escalate:** Finance/Ops lead immediately.

## 🔴 PAGE — 5xx spike / P95 breach on money endpoints
**Means:** `/api/v1/transactions`, `/checkouts/*/sales|return`, `/jobs/*/check-out` degraded.
1. `/readyz` — Mongo + KV reachable? Stripe reachable?
2. Check Mongo primary + replica lag; check event-loop lag metric.
3. Check Stripe status page.
**Mitigation:** if Stripe is degraded, the money paths fail closed (idempotent retries safe). If Mongo primary is down, failover; reads degrade to last-known.
**Escalate:** Eng on-call.

## 🔴 PAGE — Live-session staleness spike (`live_session_stale_swept_total` rising sharply)
**Means:** vendor pins are going stale — realtime broken (core value prop).
1. Check Socket.IO connected-clients + Redis adapter pub/sub latency.
2. Check the `stale-session` sweep cadence and Redis health.
**Mitigation:** clients fall back to last-known Mongo pins (flagged stale). Restart the Socket.IO tier if adapter is wedged.

---

## 🟡 NOTICE — Wave-down SLA breach rate rising (`wave_down_sla_breach_total`)
Vendors not answering in time. Product signal, not an outage. Check onboarding of active vendors.

## 🟡 NOTICE — Dispute SLA approaching (`disputes` past `sla_due_at`)
Route to Trust & Safety queue; disputes have a 5-business-day target (FR-10.2).

## 🟡 NOTICE — Fraud-flag spike (`fraud_flags_total` by type)
Ping/oversell/spot-me anomaly. Human-review queue (`GET /api/v1/admin/fraud-flags`). Never auto-ban — the docs stress the cost of wrongly banning a legitimate low-income seller.

## 🟡 NOTICE — Oversell rejects rising (`oversell_reject_total`)
Either UX drift (clients not respecting held quantity) or abuse. The server guard already blocked the sale; investigate the source.

---

## Pre-launch checklist (Modesto pilot)
- [ ] Load test passed: `node scripts/loadtest-http.mjs` (P95 < 300ms) + `loadtest-socket.mjs` (10k target).
- [ ] Dashboards live (Realtime, Money, RED, Fraud & Trust, Infra, SLA) with page/notice alerts wired.
- [ ] DLQ + on-call rotation configured for financial queues.
- [ ] Pen-test complete on auth + payment + authorization surfaces.
- [ ] Stripe **live-mode** sign-off after test-mode staging pass; fresh Connect account, accurate category, Stripe Tax on.
- [ ] Real-credential smoke tests: one live KYC verification, one live Connect onboarding + charge + payout, one R2 presigned upload.
- [ ] Consignment layer city-gated (`cities.feature_flags.consignment`) to launch cities only.
- [ ] Sponsor (Wonder Ice) UTM links live; attribution verified via `/api/v1/preregistrations`.

---

# Community network (Pay It Forward · Boost · Delivery)

Added 2026-08-04 (roadmap task 8.3). These three features share one property that changes how you
respond to anything going wrong in them: **the money is custodial.** It belongs to contributors, not
to the platform and not to the vendor. When in doubt, the safe action is the one that leaves the
money where it is and escalates — not the one that "unblocks" somebody.

There is a common shortcut worth naming: none of the ops tools can pay a person. If a fix seems to
require moving money to somebody, you have the wrong fix, not a missing tool.

## 🔴 PAGE — Community fund cache disagrees with the ledger
**Means:** `community_funds.balance_cents` and the `community_fund_payable` ledger account have
drifted. The ledger is authoritative; the cache is a projection that something failed to update —
usually a process that died between the ledger post and the cache write.
1. Confirm the drift: `GET /api/v1/admin/community-funds/:businessId/reconcile` is a POST, so read
   the ledger first via the finance ledger endpoint and compare with the fund document.
2. Check for errors around the window — `payforward FIFO could not fully allocate a redemption`
   is the log line that indicates the contribution rows and the balance disagree too.
3. Check the nightly `ledger-reconciliation` output for the same account.
**Mitigation:** `POST /api/v1/admin/community-funds/:id/reconcile` with a reason. It sets the cache
to the ledger and nothing else — it **cannot** invent a balance, so it is safe to run.
**Do not:** adjust the ledger to match the cache. The ledger is the record; the cache is the copy.
**Escalate:** Finance lead if the drift is over $20, or if it recurs for the same business — a
repeat means a code path is still failing, and reconciling repeatedly only hides it.

## 🟠 WARN — A redemption is disputed ("I was charged and the fund should have paid")
**Means:** a customer believes the community fund covered their order and their card says otherwise.
1. `GET /api/v1/admin/community-redemptions/:id` — status tells you most of it.
   - `released` → the fund was committed and handed back because the payment failed. The customer
     was charged in full and correctly; the fund was never spent.
   - `reserved` → stuck mid-flight. Rare. Escalate rather than guessing.
   - `applied` → the fund did pay. Check the order's `pay_it_forward_cents`.
2. If `applied` and the customer was still charged the full amount, that is a genuine defect —
   capture the order id and escalate; do not refund from the pool.
**Mitigation:** refund the customer from the ordinary refund path if they were wrongly charged. Never
top the fund up to compensate — that spends other people's money to fix our bug.
**Note:** the tooling deliberately cannot list who else has been helped. Do not go looking; that
question is the one this feature must never be able to answer.

## 🟠 WARN — A Boost campaign should not have run / the vendor has gone dark
**Means:** a campaign is live and needs stopping for a reason the vendor cannot or will not act on.
1. Read the campaign. If it is already `funded`, **stop** — the money has been committed and a
   mailing may be in production. Escalate instead.
2. If `open`: `POST /api/v1/admin/boost-campaigns/:id/cancel` with a reason.
**Mitigation:** cancellation refunds **every** contributor in full, including those who chose to roll
forward — a cancellation is not a missed goal, it is the thing they funded ceasing to exist.
**Escalate:** if any contributor's refund fails at the processor, the log line is
`boost refund failed at the processor` and the row is already marked refunded. That combination
means somebody believes they were refunded and was not, which is the worst state this feature has.
Finance lead, same day.

## 🟠 WARN — A delivery is stuck
**Means:** a delivery is `accepted` or `picked_up` and has not moved — a driver's phone died, or the
hand-off happened without the code being read.
1. Check the delivery. Contact the driver and the customer before deciding.
2. `POST /api/v1/admin/deliveries/:id/resolve` with `outcome: delivered` or `cancelled` and a reason.
**Which outcome:**
   - The goods arrived → `delivered`. The driver **is still paid**; a process failure is not
     grounds for withholding somebody's pay, and doing so teaches drivers not to report problems.
   - They did not → `cancelled`. The customer's delivery charge is refunded automatically.
**Escalate:** any report of injury, an accident, or a safety concern goes to the on-call lead
**immediately** and is filed as an incident (`POST /deliveries/:id/incidents`). Delivery is the only
part of this platform with third-party physical risk; treat it accordingly.

## 🟠 WARN — No drivers are accepting anything
**Means:** `delivery-offer-sweep` is expiring requests with `no_driver_accepted` across the board.
1. Are there any on-shift, eligible drivers? Eligibility needs an approved profile, a passed
   background check, both attestations in date, **and a payout account**.
2. Check the `driver-lapse` sweep — a batch of expiring insurance dates can suspend several drivers
   at once, and they will not know until they look.
3. Check whether vendors are offering a reasonable payout. The vendor sets it; a very low offer is a
   product problem, not an outage.
**Mitigation:** nothing to fix technically if drivers are simply unavailable. **No customer has been
charged** — the charge happens at acceptance — so the correct action is to tell the vendors, not to
intervene in the requests.

## 🔵 INFO — Rolled-forward Boost money is expiring
**Means:** the `boost-rollover` sweep is refunding contributions whose "put it toward the next
campaign" never found a next campaign within 60 days.
**Action:** none. This is the feature working — the time-box exists so roll-forward cannot become an
indefinite hold. Worth noticing only if the volume is high, which means vendors are starting
campaigns and then not following up.
