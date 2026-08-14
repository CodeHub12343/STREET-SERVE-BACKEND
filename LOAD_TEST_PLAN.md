# Load test plan

**Written 2026-08-04** (roadmap task 8.7).

> ### The task is not complete, and this document is why
>
> 8.7 says *"load test at projected launch volume"*. Two things were missing, and only one of them
> is a script:
>
> 1. **Nobody had written down what "projected launch volume" is.** You cannot test at a number
>    nobody has stated. That number is defined below, with its assumptions, so it can be argued
>    with — which is the point of writing it down.
> 2. **The existing harness only exercised `/map/nearby`** — the cheapest read on the platform.
>    Passing it tells you the map is fast and nothing about checkout. `scripts/loadtest-scenarios.mjs`
>    now runs a weighted mix.
>
> **The run itself is still outstanding.** It needs a production-like environment — real Mongo Atlas
> with the production index set, real Redis, more than one app instance. Running it against a laptop
> with an in-memory Mongo would produce numbers that mislead rather than inform, and a green result
> from that setup is worse than no result because someone would believe it. Checklist item 9.15
> stays open.

---

## Projected launch volume

The pilot is **one city: Modesto, CA** (~220,000 people).

Every figure below is an assumption, stated so it can be challenged. They are deliberately on the
generous side — a load test tuned to the volume you *expect* tells you nothing about the Saturday
you did not.

| Quantity | Launch estimate | Reasoning |
|---|---|---|
| Registered vendors/sellers | 300 | A pilot that signs up 300 in a city of 220k is doing well |
| **Concurrently live** at peak | **120** | Lunch and dinner rushes; ~40% of the roster live at once |
| Registered customers | 6,000 | 2% of the city in the first months |
| Peak concurrent customers | 400 | Weekend lunch |
| Orders/hour at peak | 250 | ~2 per live vendor per hour |
| Consignment checkouts/day | 80 | |
| RTO agreements, active | 150 | Small, growing; the load matters at the 1st and 15th |

### What that implies for the API

| Path | Peak rate | Why |
|---|---|---|
| `GET /map/nearby` | **~40 rps** | 400 customers, polling/panning roughly every 10s |
| `GET /map/trending` | ~10 rps | Opened less often than the map itself |
| `POST /orders/quote` | ~5 rps | Every order previews at least once, usually more |
| `POST /orders` | ~0.1 rps | 250/hour |
| Socket connections | **~520** | Every live vendor and active customer holds one |

**The headline: ~55 rps of reads and a handful of writes.** That is small. The reason to load-test
anyway is not throughput — it is to find the *shape* of the first failure, which the sweep model
already predicts will be `proximity-alert-eval` saturating on latency rather than any HTTP path.

### The test target

Run at **4× the peak estimate**: 220 rps, 500 concurrent connections, 5 minutes. Four is not
a principled constant — it is enough headroom that a launch-day surprise is absorbed rather than discovered, and small
enough that failing it means something real.

```bash
node scripts/loadtest-scenarios.mjs https://api.staging.streetserve.example 500 300 "$ACCESS_TOKEN"
node scripts/loadtest-socket.mjs   https://api.staging.streetserve.example 520
```

---

## Budgets

From the NFRs, unchanged: **P95 < 300ms reads, < 800ms writes, 99.5% uptime.**

The scenario harness fails the run if any scenario exceeds its budget, or if more than 1% of
requests error. A 4xx counts as an error — a load test measuring rejected requests is measuring
nothing, and an expired token silently turning the run into a 401 benchmark is the most common way
a load test lies.

---

## What to watch while it runs

Latency percentiles are the output; these are the causes, and they are where the answer will be:

1. **`sweep_batch_saturated_total`** — the sweeps run on the same database. If they start shedding
   work under HTTP load, that is the interaction the sweep model could not predict on paper.
2. **`proximity-alert-eval` tick duration.** `SWEEP_LOAD_MODEL.md` predicts this saturates first,
   on latency rather than batch size. This run is the chance to confirm or refute that before it
   matters.
3. **Fee-cache behaviour across instances.** With more than one app instance, confirm the Redis
   pub/sub invalidation works under load — change a fee mid-run and watch both instances converge.
   That is A-3's whole purpose and it has never been exercised with real concurrency.
4. **Mongo connection pool saturation**, and whether `$near` queries start queueing.
5. **The block-party detector** — the acknowledged Mongo-geo scaling risk
   (`BACKEND_ARCHITECTURE.md` §3), which no model here covers because it needs measurement.

---

## What a green run would and would not prove

**Would:** the HTTP surface holds at 4× projected launch volume, and the first bottleneck is where
the model says it is.

**Would not:**
- That the platform holds at 40×. Growth needs re-measuring, not extrapolating.
- That the sweeps keep up over a *day*. This is a 5-minute window; `consignment-expiry-notices` runs
  daily and `rto-installments` clusters on the 1st and 15th. Those need a soak test.
- Anything about Stripe. The harness does not place real charges, so the money path is measured up
  to the point where it hands off — and the handoff is the slowest part.
