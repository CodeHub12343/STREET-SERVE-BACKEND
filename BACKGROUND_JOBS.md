# StreetServe — Background Jobs (BullMQ)

> Async and scheduled work off the request path: settlement, Trust Score, notification fan-out, ping-fraud, SLA sweeps, Block Party detection, reconciliation.
> **Engine:** BullMQ (Redis-backed). **Runtime:** dedicated worker process (`worker.ts`) scaled independently of the API.
> Companion: [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md) §5, [REALTIME_ARCHITECTURE.md](REALTIME_ARCHITECTURE.md).

---

## 1. Why BullMQ, and the Worker Topology

The docs name BullMQ for "settlement reconciliation, Trust Score recalculation, notification fan-out, ping-fraud checks." Same Redis as Socket.IO + cache (separate key prefix). Workers run as a **separate dyno from the same image** (`npm run worker`), so bursty async work never competes with request-path latency and the two scale independently.

```
API instance ──(add job)──► Redis (BullMQ queues) ──► Worker instance(s) ──► processors
        ▲                                                     │
        └──────────── domain events / socket emits ◄──────────┘
```

Every job is **idempotent** (safe to retry), keyed so duplicate enqueues coalesce where relevant, and emits a domain/notification event on completion.

---

## 2. Queues

| Queue | Concurrency | Purpose |
|---|---|---|
| `settlement` | low, ordered | Consignment settlement math + payout initiation (financial correctness) |
| `payments` | low | Payout initiation, refunds, clawbacks, tip transfers |
| `trust` | medium | Trust Score recomputation |
| `notifications` | high | Multi-channel fan-out (socket/push/SMS/email) |
| `fraud` | medium | Ping/oversell/spot-me anomaly scoring |
| `sweeps` | scheduled | Time-based sweeps (SLA, stale sessions, overdue returns, reminders) |
| `geo` | scheduled | Block Party detection sweep |
| `reconciliation` | scheduled | Nightly Stripe ↔ ledger diff |
| `maintenance` | scheduled | Retention purge/aggregate, index health, giveaway resets |

---

## 2a. Choosing between a sweep and an event

**Sweeps for money and cleanup. Events for interaction.**

The distinction is latency tolerance, and it is worth stating as policy because the pull is always
toward a sweep: most fan-out here already is one, so a sweep is the pattern a developer sees first
and copies.

| | **Scheduled sweep** | **Event-triggered** |
|---|---|---|
| Use when | Nobody is waiting. A minute of latency costs nothing | Somebody is waiting, and the delay *is* the experience |
| Typical work | Settlement, reconciliation, expiry, reminders, retention | Dispatch, offers, acceptance, live status |
| Discovers work by | Re-scanning state to find what changed | Being told what changed |
| Failure mode | Falls behind under load — visible, and bounded by batch size | Lost event — needs a sweep as a backstop |

The reasoning is already recorded in the codebase at
[`livemap.service.ts`](src/modules/livemap/livemap.service.ts), where corridor alerts fire on the
event *"rather than by a sweep"* because *"the event already knows which vendor changed; sweeping
would re-test every corridor against every live vendor every minute to rediscover it."* That is the
general argument: a sweep re-derives information the event already had.

**Two rules that follow:**

1. **A sweep's cadence is a latency budget.** `proximity-alert-eval` runs every 60s, which is right
   for "a vendor you follow is nearby" and wrong for anything a person is actively waiting on. Do
   not reuse an existing sweep's cadence without re-asking what the user is waiting for.
2. **Event-driven paths still need a sweep behind them** — for expiry, re-broadcast, and recovery
   from a dropped event. The event carries the latency; the sweep carries the guarantee. Wave-downs
   are the model: accepted over a socket, expired by `wave-down-sla-sweep`.

**Worked example — delivery dispatch (Phase 5).** The broadcast to nearby drivers is event-driven:
it fires when the request is created, because a vendor who has tapped "Need Delivery Help" is
standing at their truck watching for a driver, and up to a minute of silence reads as a broken
button. The expiry, the re-broadcast when nobody accepts, and the no-driver-found fallback are
sweeps, because by then the deadline is the point. Reusing the `proximity-alert-eval` cadence for
the broadcast would have been the natural-looking mistake.

---

## 3. Event-Triggered Jobs

| Job | Trigger (event) | Work | Idempotency |
|---|---|---|---|
| **process-settlement** | `inventory.returned` / settle request | Compute gross−fee−hubShare=net; write immutable `settlements`; enqueue payout; emit receipt | Keyed on `checkout_id`; refuses to write a 2nd settlement for a settled checkout |
| **initiate-payout** | `inventory.settled`, `job.checked_out` | Stripe transfer per tier timing (Bronze 3d hold / Silver next-day / Gold instant); record `payout_ref` | Idempotency-Key = settlement id |
| **recompute-trust** | `inventory.settled`, `dispute.resolved`, `booking.no_show`, review created | Apply versioned formula; write new `trust_scores` doc (never mutate) | Latest-wins by `computed_at` |
| **apply-dispute-outcome** | `dispute.resolved` | Post-resolution score change (never pre-emptive, FR-10.3); clawback via documented reversal if needed | Keyed on dispute id |
| **fanout-notification** | any notifiable event | Resolve prefs → dispatch per channel; safety-critical bypass mute→email | Keyed on (event id, user, channel) |
| **score-ping-fraud** | `ping.logged`, `ping.qualified` | Device/velocity/uniqueness checks; raise `fraud_flags`; gate tip payout | Keyed on ping id |
| **pay-ping-tip** | `ping.qualified` (passed fraud) | Transfer per-share tip; decrement `ping_budgets.balance_cents` atomically | Keyed on ping id |
| **process-gift** | `gift.created` | Generate redemption code, schedule pre-expiry notice | Keyed on gift id |
| **block-party-broadcast** | `block_party.detected` | Fan-out to opted-in users within wider radius (default 1mi) via notifications | Keyed on event id |

---

## 4. Scheduled (Repeatable) Jobs

| Job | Cadence | Work | FR |
|---|---|---|---|
| **wave-down-sla-sweep** | every 30s | Expire `pending` wave-downs past `expires_at`; notify requester + suggest next-closest | FR-2.2 |
| **stale-session-sweep** | every 30–60s | Mark `live_sessions` with no tick past TTL; emit `pin:remove` | FR-1.2, availability |
| **job-no-show** | every 5 min | Release gigs `filled` but never checked into, past `starts_at` + `JOB_NO_SHOW_GRACE_MIN` (90m); mark the application `no_show` and reopen the posting | S-14, Flow 9 |
| **block-party-detect** | every 60s | Geohash-bucketed cluster scan (≥2 within 150m for ≥10min) → write event + broadcast | FR-4.2 |
| **queue-hold-expiry** | every 60s | Release queue spots past `hold_expires_at` (config per vendor) | FR-3.4 |
| **booking-reminders** | every 5min | Fire 24h + 1h reminders (`reminder_sent_*` flags) | FR-7.2 |
| **overdue-return-sweep** | every 15min | Flag checkouts past `expected_return_at` + grace (24h) → penalty + reservation-limit reduction; notify hub | FR-8.5 |
| **spot-me-due-reminder** | hourly | Remind on approaching `repay_by`; mark `defaulted` past due → reputation consequence (no collections) | FR-6.3 |
| **gift-expiry-notice** | hourly | 48h-before-expiry sender notice; expire past `expires_at` | FR-6.1 |
| **giveaway-reset** | daily 00:00 local | Reset `quantity_claimed_today` at `reset_at` | FR-6.2 |
| **nightly-trust-recompute** | nightly | Full recompute for all subjects (formula version stamped) | Business rules |
| **proximity-alert-eval** | every 60s | Match followed/notify-me/home-area radius against active sessions; respect 1/vendor/2h throttle | FR-1.4 |
| **notify-me-fulfillment** | every 60s | Match pending `notify_me_requests` against away_closed→driving/parked transitions | Flow 2b |
| **stripe-reconciliation** | nightly | Diff ledger mirror vs Stripe balances/transfers; raise ops flag on drift | Security §2 |
| **location-retention-purge** | daily | Purge/aggregate `location_pings` >30 days (backstop to TTL index) | Q7 |
| **dispute-sla-alert** | hourly | Alert on disputes approaching/breaching `sla_due_at` | FR-10.2 |
| **ping-budget-lowbalance** | hourly | Notify vendor on low/depleted paid-sharing balance | Flow 11 |

---

## 5. Retry, Backoff & Failure Policy

- **Default:** 3–5 attempts, exponential backoff with jitter.
- **Financial jobs (`settlement`, `payments`):** conservative retry (fewer attempts, longer backoff) + **manual dead-letter review** — never silently retry a money move into duplication; rely on Stripe idempotency keys so a retry is safe.
- **Dead-letter queue** per queue; failed financial jobs page on-call and land in an admin review surface.
- **Poison-message protection:** cap attempts, then park in DLQ with full context for human triage.
- **Idempotency everywhere:** every processor is safe to run twice (keyed writes, conditional updates, Stripe idempotency keys). A retried settlement must not double-pay.
- **Ordering:** settlement/payout jobs for the same checkout are serialized (job key / FIFO) to avoid interleaving.

---

## 6. Observability

- Per-queue metrics: depth, throughput, failure rate, processing latency, DLQ size — exported to Prometheus (see [LOGGING_AND_MONITORING.md](LOGGING_AND_MONITORING.md)).
- **Alert on:** settlement processing latency, DLQ growth, reconciliation drift, dispute-SLA breach, wave-down-SLA breach rate, live-session staleness rate (the docs' named alert metrics).
- Correlation IDs propagate from the triggering request/event into the job for end-to-end tracing.
- BullMQ dashboard (Bull Board) exposed to admins in non-prod / behind admin auth in prod.

---

## 7. Scheduling Notes
- Repeatable jobs registered once at worker boot from `jobs/scheduler.ts`; a single scheduler owner avoids duplicate cron across instances (BullMQ repeatable jobs dedupe by key).
- Time-zone-sensitive jobs (giveaway reset, local reminders) compute against the city/vendor locale, not server UTC blindly.
- Sweep cadences are config-driven so they can be tuned under load without a deploy.
