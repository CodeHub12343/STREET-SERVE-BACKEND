# Sweep load model

**Written 2026-08-02** (roadmap task 5.3). Models every scheduled sweep against projected launch
volume, and says at what scale each one stops keeping up.

> **This is arithmetic, not measurement.** There is no production traffic yet, so every number below
> is derived from the code's own cadences and batch limits plus a stated volume assumption. Where a
> figure needs real data to settle, it says so rather than guessing.

---

## How a sweep's capacity works

Every sweep reads a bounded page of due work and processes it serially:

```
capacity (items/minute) = SWEEP_BATCH_LIMIT ÷ cadence
```

`SWEEP_BATCH_LIMIT` is **500**, shared by every sweep (`src/jobs/sweepBatch.ts`). The bound is
correct — an unbounded sweep is a memory incident waiting for a bad day — but before 5.3 hitting it
was **invisible**: a tick that processed 500 of 4,000 due items returned `500`, logged success, and
deferred the rest. If arrivals exceed capacity the backlog grows without bound while every
individual run looks healthy.

That is now instrumented. A full batch increments `sweep_batch_saturated_total{sweep}` and logs a
warning. **One saturated tick is normal** (a deploy, a backfill, a payment date). Sustained
saturation is the alert:

```promql
# Alert: a sweep has been shedding work for 15 minutes
sum by (sweep) (rate(sweep_batch_saturated_total[15m])) > 0.9 * sum by (sweep) (rate(sweep_ticks_total[15m]))
```

There is a second limit that no batch size fixes: **the tick must finish before the next one
starts.** Sweeps process items serially with awaits, so wall-clock time is
`items × per-item latency`. At 20 ms per item, a 500-item batch takes 10 seconds — fine at a 60 s
cadence, and 100% of the window at 30 s.

---

## The three sweeps named in the task

### `wave-down-sla` — every 30 s, cap 500

Expires wave-downs nobody answered inside `WAVE_DOWN_SLA_DEFAULT_SEC` (300 s).

| | |
|---|---|
| Capacity | 1,000 expiries/minute |
| Work per item | 1 conditional update + 1 notification |
| Saturates at | ~1,000 *unanswered* wave-downs per minute |

**Assessment: not the constraint.** Unanswered wave-downs are a fraction of all wave-downs, and
1,000/min of them implies a volume far past pilot scale. The 30 s cadence is driven by the SLA's
precision, not by throughput — at 30 s the worst-case expiry lag is 5 min + 30 s, which is the right
trade.

**Watch instead:** the per-item notification. If notification delivery ever becomes a synchronous
network call, a 500-item batch becomes 500 sequential round trips and wall-clock time — not the
batch limit — becomes the ceiling.

### `stale-session` — every 60 s, cap 500

Closes live sessions with no ping for `LIVE_SESSION_TTL_SEC` (60 s).

| | |
|---|---|
| Capacity | 500 closures/minute |
| Work per item | 1 update + 1 Redis geo removal + 1 socket emit |
| Saturates at | ~500 vendors going silent per minute |

**Assessment: adequate, with one caveat that matters more than the number.** Vendors do not go
offline uniformly — they go offline in a **wave at closing time**. A market with 3,000 active
vendors where a third stop pinging within the same five minutes produces 1,000 stale sessions in
that window against a 2,500-item capacity. That clears.

The real risk is a **correlated network event**: a mobile carrier blip that stops pings from
everyone at once produces N stale sessions in one tick, where N is the whole active fleet. At 3,000
active vendors that is 6 ticks (6 minutes) of a map showing trucks that are, in fact, still there —
because the sessions were never actually stale. Batch limits do not help; **the fix is that the sweep
is idempotent and reversible**, which it is (a vendor pinging again reactivates).

**Ceiling: ~500 concurrent live vendors per minute of drain.** Past a few thousand active vendors,
shard by geohash prefix rather than raising the limit — one slow region should not delay another.

### `proximity-alert-eval` — every 60 s, cap 500 — **the actual constraint**

For each active session, alert followers whose home is within `PROXIMITY_HOME_RADIUS_M`, throttled
per (vendor, user) per 2 h.

This one is **not** `O(items)`. Per active session it runs:

1. `listFollowersOf(business)` — 1 query
2. `pendingNotifyMe(business)` — 1 query
3. a `$near` geo query over the candidate set — 1 query, the expensive one
4. one Redis `SETNX` per nearby user

| Active sessions | Queries/tick | At 5 ms each | At 20 ms each |
|---|---|---|---|
| 100 | 300 | 1.5 s | 6 s |
| 500 (the cap) | 1,500 | 7.5 s | **30 s** |
| 2,000 (shed) | — | — | — |

**Assessment: this saturates first, and it saturates on latency before it saturates on the batch
limit.** At 500 active sessions and a 20 ms geo query, a tick consumes half its 60 s window; a
slower disk or a cold index consumes all of it and ticks begin to overlap.

Worse, the batch limit **silently truncates fairness**: `activeSessions(500)` returns whichever 500
the index yields, so with 800 active vendors the same 300 never generate proximity alerts, every
tick, indefinitely. That is a correctness problem wearing a performance problem's clothes, and it is
why this sweep now reports saturation against **sessions scanned** rather than notifications sent.

**Recommended before ~300 concurrent active vendors** (in priority order):

1. **Invert the query.** Instead of per-session `$near` over followers, maintain a geohash bucket of
   follower home locations and intersect. Turns 3 queries per session into 1 per geohash cell.
2. **Only evaluate sessions that moved.** A parked truck alerting the same neighbourhood every
   minute is throttled at the notification layer but still pays all three queries. Skipping sessions
   whose geohash is unchanged since the last tick removes most of the work at no behavioural cost.
3. **Then** shard by region.

---

## Every other scheduled job

| Sweep | Cadence | Cap | Capacity | Notes |
|---|---|---|---|---|
| `queue-hold-expiry` | 60 s | 500 | 500/min | Holds are 15 min; ample. |
| `block-party-detect` | 60 s | — | — | Application-level geohash sweep. **The known scaling risk in `BACKEND_ARCHITECTURE.md` §3** — the one workload the docs warn Mongo makes us engineer. Not modelled here; needs measurement. |
| `job-no-show` | 5 min | 500 | 100/min | 90-minute grace; ample. |
| `booking-reminders` | 5 min | — | — | Calendar-driven, clusters at business hours. |
| `sale-payment-expiry` | 5 min | **100** | 20/min | The tightest per-tick cap on the platform (`findExpired` defaults to 100, and the sweep does not override it). Fine at rest — expiring intents are rare — but under a payment-provider outage every pending intent expires at once, and 20/min is a slow drain for units held out of stock. |
| `ad-settlement` | 5 min | 200/100 | — | Impressions batch at 25 before a write, so the read is already amortised. |
| `payout-retry` | 15 min | — | — | Retries only failed legs; naturally small. |
| `overdue-return-sweep` | 15 min | 500 | 33/min | Daily-scale work on a 15-min cadence; large headroom. |
| `rto-installments` | hourly | 500 | **12,000/day** | ⚠️ See below. |
| `dispute-sla-alert` | hourly | — | — | Alert-only. |
| `gift-expiry`, `spot-me-defaults` | hourly | 500 | 12,000/day | Ample. |
| `consignment-expiry-notices` | daily 09:00 | 500 | **500/day** | ⚠️ See below. |
| `rto-reminders` | daily 10:00 | 500 | 500/day | Daily by design — §49's five stages are calendar events, and four nudges a day about one payment is harassment. |
| `debt-reminders` / `debt-escalation` | daily 10:00/10:30 | — | — | |
| `fraud-signals` | daily 05:00 | — | — | Flags for human review, never auto-enforced. |
| `balance-monitor` | hourly | — | — | Solvency drift; must run before a payout fails. |
| `reconciliation` (Stripe, ledger) | nightly | — | — | |
| `giveaway-reset` | daily 00:05 | — | — | |
| `daily-maintenance` | daily 04:00 | — | — | |

### ⚠️ `rto-installments` — hourly, 500/tick

Capacity is 12,000 installments/day, which sounds generous and is not, because **installments
cluster**. Sellers default to `monthly`, customers pick payday dates, and the 1st and 15th absorb a
disproportionate share. If 40% of a 20,000-agreement book falls due on the 1st, that is 8,000
charges in a day — inside capacity overall, but the *first* hourly tick after midnight sees all
8,000 due and processes 500, so the last customer is charged **16 hours late**.

Nothing breaks. But an RTO charge landing at 4 p.m. instead of 9 a.m. is a customer-visible failure
on a payment they budgeted for, and it will read as an unpredictable platform.

**Recommendation:** the cadence is the wrong knob — every-15-minutes with the same cap quadruples
capacity without touching batch size, and idle ticks cost one indexed query. Do this **before** the
RTO book passes ~2,000 active agreements.

### ⚠️ `consignment-expiry-notices` — daily, 500/tick

500/day is the tightest capacity of any sweep here, and expiries cluster harder than installments,
because the default term is 30 days and intake is lumpy. A single hub onboarding 600 products in a
week produces >500 expiries in a day, one month later, forever.

Worse than lateness: a notice that is *late* is a notice that arrives after the term ended. §38
requires expiry **notices**, which only work in advance.

**Recommendation:** raise this sweep's limit specifically, or run it hourly and let the per-item
idempotency (already present — notices are keyed by stage) prevent duplicates. Do this before any
single hub exceeds ~400 concurrent consignments.

---

## Summary — what to fix, in order

1. **`proximity-alert-eval`** — silently drops vendors past 500 active sessions, and the per-session
   `$near` makes it the first sweep to run out of wall clock. Fix before ~300 concurrent vendors.
2. **`consignment-expiry-notices`** — 500/day is the tightest cap on the platform, against clustered
   demand, on a notice that is worthless if late.
3. **`rto-installments`** — raise the cadence, not the batch, before ~2,000 active agreements.
4. **`sale-payment-expiry`** — raise its 100-item cap toward the shared 500, so a provider outage
   does not leave consignment units held out of stock for an hour.
5. **`block-party-detect`** — the acknowledged Mongo-geo risk. Needs measurement, not arithmetic.

## Realtime write load — the class this document did not model

**Added 2026-08-04** (community-network roadmap task 1.5). Everything above models *sweeps*: bounded
batches of work discovered by re-scanning state. The Delivery Assist Network introduces a load class
with none of those properties, and no batch limit to hide behind.

### Why it is different

Every realtime path shipped so far is **event-shaped and low-frequency**: a pin moves when a vendor
moves, a queue updates when someone joins, a message arrives when someone sends one. Traffic is
proportional to human actions.

A courier position stream is **sustained**: while a delivery is in flight, the driver's device emits
whether or not anything interesting happened, and each emit fans out to at least the customer. Load
is proportional to *elapsed delivery-minutes*, not to actions.

### The arithmetic

Per active delivery, at one position every `1/hz` seconds:

```
emits/sec            = hz
fan-out writes/sec   = hz × (watchers + 1)     // customer, and the vendor if shown
total writes/sec     = deliveries × hz × (watchers + 1)
```

At the harness default of **hz = 0.5** (one position every two seconds) and one watcher:

| Concurrent deliveries | Emits/sec | Socket writes/sec | Sockets held |
|---|---|---|---|
| 10 | 5 | 10 | 20 |
| 40 | 20 | 40 | 80 |
| 100 | 50 | 100 | 200 |
| 500 | 250 | 500 | 1,000 |

These are small numbers in absolute terms, and that is the honest headline: **Socket.IO is not the
constraint at pilot scale.** Two things are.

1. **The map route is already at ~95% of its performance budget** (PERFORMANCE_BASELINE.md). Courier
   presence shares that infrastructure. The delivery stream does not need a large share of what is
   left to exhaust it, and it is the *same* budget PIF-13/14's discovery facets want.
2. **Persistence, not transport.** `location_pings` has a 30-day TTL and is already the platform's
   highest-write collection. At hz = 0.5 a single 20-minute delivery writes ~600 rows. A hundred
   deliveries a day is 60k rows/day from delivery alone, retained for a month.

### The decisions this produces

- **Do not persist courier positions at full fidelity.** Stream through the Redis hot mirror; persist a decimated trace — or only pickup and drop-off — for dispute evidence. The 30-day retention that suits vendor history is over-retention for a worker's precise minute-by-minute movements, and it is a privacy exposure as much as a storage one.
- **Enforce the ping rate server-side.** A client bug, or a driver with two app instances, must not be able to raise `hz`. The ceiling belongs on the server, with sampling above it.
- **Isolate the namespace** so the stream can be rate-limited or shed without touching `/live`, `/queue`, or `/messages` (ARCHITECTURAL_IMPROVEMENTS A-7).
- **Fan out only to the active delivery's room**, and only between acceptance and completion. This is a privacy rule first, but it is also what keeps the write count proportional to deliveries rather than to viewers.

### Measuring it

`scripts/loadtest-socket.mjs --scenario=courier` implements the above. It opens two sockets per
delivery — a producer emitting `delivery:position`, a consumer in the same room — and reports
**fan-out latency** (producer emit → consumer receipt) at p50/p95/p99 plus a delivered percentage.

```bash
node scripts/loadtest-socket.mjs http://localhost:8080 40 "$TOKEN" --scenario=courier --hz=0.5 --seconds=120
```

Pass/fail budget encoded in the script: ≥99% of frames delivered and **p95 fan-out ≤ 1s**. A tracker
one second behind the road is still honest; five seconds behind is a lie about where the driver is.

> **The script targets the `/delivery` namespace, which does not exist yet** — it lands with DAN-6
> (Phase 5e). It is written first deliberately: the ping ceiling and the persistence policy are cheap
> to choose now and expensive to change once a tracker UI depends on them.

---

## What this document cannot tell you

Per-item latency. Every "at 20 ms each" above is an assumption. The instrumentation added in 5.3
(`sweep_items_processed_total`, `sweep_batch_saturated_total`) plus the existing `/metrics` histogram
is what turns these estimates into measurements, and **the first week of real traffic should be spent
replacing the assumed numbers here with observed ones.** That is also the point at which task 5.4
(index coverage against real query patterns) becomes answerable.
