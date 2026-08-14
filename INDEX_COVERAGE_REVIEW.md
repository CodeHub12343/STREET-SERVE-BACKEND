# Index coverage review

**Written 2026-08-02** (roadmap task 5.4).

> ### What this is not
>
> The task reads *"review index coverage against real query patterns **once production traffic
> exists**."* **It does not exist.** There is no traffic, no slow-query log, and no `$indexStats`, so
> the part of this task that needs measurement **cannot be done yet and has not been faked.**
>
> What *can* be done now, and is done here, is the static half: cross-reference every query the
> source actually issues against the indexes each collection declares. That finds missing indexes.
> It cannot find **unused** ones, which is the other half of coverage and needs `$indexStats` from a
> real cluster.

---

## Method

A one-off script extracted, from `src/`:

- every `XSchema.index({...})` declaration and every inline `index: true`
- every `Model.find / findOne / updateMany / countDocuments / deleteMany` filter, reduced to its
  top-level keys

…then reported filters whose keys are not the prefix of any declared index. That produced **32
candidate gaps across 67 models**, which were then triaged by hand. Most were false positives, and
the reasons are worth recording because they are the traps in this kind of analysis:

| False-positive class | Why the script was wrong |
|---|---|
| `unique: true` fields | Mongo creates an index for a unique constraint. `pay_token`, `stripe_account_id`, `redemption_code`, `stripe_payment_intent_id`, `idempotency_key`, `City.slug`, `SellerProfile.user_id`, `Hub.business_id` were all already covered. |
| Schemas outside `*.model.ts` | `WaiverUse` and `WeatherCache` are declared in service files and index themselves there. |
| Key-order sensitivity | The script compared against the *first* filter key; Mongo can use an index whose prefix matches *any* equality key. |

**Three real gaps survived.** All three are fixed — declared in the schema (documentation) and built
by `migrations/20260802000001-index-coverage-review.js` (the actual change, since `autoIndex` is off
in production).

---

## Fixed

### 1. `verification_records.provider_reference` — the highest-value one

A KYC webhook arrives knowing only the provider's own reference, so `findOne({ provider_reference })`
runs on **every callback** — and ran as a collection scan. Cheap at today's size and monotonically
worse, on a path with a tight latency budget and a provider that retries on timeout.

Built as a **partial** index on `$type: 'string'`: most records never receive a provider reference,
and indexing thousands of nulls costs write throughput for a key nobody queries by.

### 2. `hubs.owner_user_id`

`hubs` carried only its 2dsphere index, so "my hubs" — the first query every hub-owner screen makes
— scanned every hub on the platform.

### 3. `jobs_postings.poster_user_id + created_at`

The public browse shapes were indexed (`status+created_at`, `status+job_type+created_at`); the
poster's own dashboard was not.

---

## Deliberately not indexed

Recording these matters as much as the fixes — an index has a write cost, and "add one everywhere"
is not a strategy.

| Query | Why not |
|---|---|
| `City.findOne({ slug \| status \| state })` | Cities number in the tens. A scan of 30 documents beats maintaining three indexes, and `slug` is already unique-indexed anyway. |
| `Category.find({ active })`, `Sponsor.find({ active })` | Small, near-static reference collections. |
| `FraudFlag.countDocuments({ status })` | Admin dashboard only, run by a handful of people. Revisit if the collection passes ~100k. |
| `User.countDocuments({ created_at })`, `Order.countDocuments({ created_at })` | Admin dashboard counts over the two largest collections — the one entry here that is a genuine judgement call. Left alone because it is a scan a human triggers, not one on a request path, and adding a `created_at` index to `users` and `orders` costs write throughput on the two hottest write paths to speed up a page nobody waits on. **Revisit if the admin overview gets slow, not before.** |

---

## What still needs real traffic

1. **Unused indexes.** 107 indexes are declared. Some are certainly dead weight — every index is
   paid for on every write. `$indexStats` after a month of traffic is the only honest way to find
   them.
2. **Whether the compound orders are right.** `{status, created_at}` is correct if status is
   selective; if 95% of postings are `open`, the index barely narrows anything and the sort does the
   work. Only real cardinality tells you.
3. **The `$near` in `proximity-alert-eval`.** `users.home_location` has its 2dsphere index, so the
   query is *indexed*; whether it is **fast enough at 500 sessions per tick** is a latency question,
   and `SWEEP_LOAD_MODEL.md` flags it as the first sweep expected to saturate.
4. **Collection-scan detection in general.** Enable the profiler at a slow-query threshold and read
   it weekly for the first month. That, not this document, is what closes task 5.4.
