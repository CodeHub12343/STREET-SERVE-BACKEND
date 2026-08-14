#!/usr/bin/env node
/**
 * 8.7 — scenario load harness.
 *
 * ## Why this exists alongside `loadtest-http.mjs`
 *
 * That harness hammers `/map/nearby` — the cheapest read on the platform, a single indexed geo
 * query. It is a fine smoke test and a misleading load test: passing it tells you the map is fast
 * and nothing about whether checkout holds up, which is the path where being slow costs money and
 * being wrong costs trust.
 *
 * This runs a **mix**, weighted to look like a real hour. The weights are the point — a load test
 * whose traffic shape does not resemble production measures a system nobody will ever run.
 *
 * ## Read the plan before the numbers
 *
 * `LOAD_TEST_PLAN.md` states the projected launch volume these weights come from and what each
 * budget means. Numbers from this script without that context are just numbers.
 *
 * Usage:
 *   node scripts/loadtest-scenarios.mjs <baseUrl> <concurrency> <durationSec> <token>
 *
 * The token must belong to a customer with a live queue position and at least one order, or the
 * authenticated scenarios measure 401s rather than work.
 */
import http from 'node:http';
import https from 'node:https';

const baseUrl = process.argv[2] ?? 'http://localhost:8080';
const concurrency = Number(process.argv[3] ?? 100);
const durationSec = Number(process.argv[4] ?? 30);
const token = process.argv[5] ?? '';

/**
 * The traffic mix, and the latency budget for each.
 *
 * `weight` is a share of requests. `budgetMs` is the P95 the NFR sets: **300ms for reads, 800ms for
 * writes**. Writes are given more room because they touch the ledger and Stripe; reads have no such
 * excuse.
 *
 * The quote is included and weighted heavily on purpose. It is a *read* by HTTP method and a
 * pricing computation by cost — it resolves the menu, the queue discount, live flash sales, and the
 * whole fee registry. If anything on the money path degrades first, it is this, and it is the last
 * thing a customer sees before deciding to pay.
 */
const SCENARIOS = [
  {
    name: 'map/nearby',
    weight: 40,
    budgetMs: 300,
    method: 'GET',
    path: '/api/v1/map/nearby?lat=37.64&lng=-121.0&radius=3000',
    auth: false,
  },
  {
    name: 'map/trending',
    weight: 15,
    budgetMs: 300,
    method: 'GET',
    path: '/api/v1/map/trending?lat=37.64&lng=-121.0',
    auth: false,
  },
  {
    name: 'catalog/categories',
    weight: 10,
    budgetMs: 300,
    method: 'GET',
    path: '/api/v1/catalog/categories',
    auth: false,
  },
  {
    name: 'orders/mine',
    weight: 10,
    budgetMs: 300,
    method: 'GET',
    path: '/api/v1/orders/mine',
    auth: true,
  },
  {
    name: 'notifications inbox',
    weight: 10,
    budgetMs: 300,
    method: 'GET',
    path: '/api/v1/users/me/notifications?limit=20',
    auth: true,
  },
  {
    // The expensive one. See the comment above.
    name: 'orders/quote',
    weight: 15,
    budgetMs: 300,
    method: 'POST',
    path: '/api/v1/orders/quote',
    auth: true,
    body: () => JSON.stringify({ businessId: process.env.LOADTEST_BUSINESS_ID ?? '', items: [] }),
  },
];

const total = SCENARIOS.reduce((sum, s) => sum + s.weight, 0);
const url = new URL(baseUrl);
const client = url.protocol === 'https:' ? https : http;

const stats = new Map(SCENARIOS.map((s) => [s.name, { latencies: [], errors: 0 }]));
let done = 0;
const endAt = Date.now() + durationSec * 1000;

function pick() {
  let roll = Math.random() * total;
  for (const scenario of SCENARIOS) {
    roll -= scenario.weight;
    if (roll <= 0) return scenario;
  }
  return SCENARIOS[0];
}

function hit() {
  if (Date.now() >= endAt) return;
  const scenario = pick();
  const target = new URL(scenario.path, baseUrl);
  const payload = scenario.body ? scenario.body() : null;
  const headers = {
    ...(scenario.auth && token ? { authorization: `Bearer ${token}` } : {}),
    ...(payload ? { 'content-type': 'application/json' } : {}),
  };

  const start = process.hrtime.bigint();
  const req = client.request(
    target,
    { method: scenario.method, headers },
    (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const bucket = stats.get(scenario.name);
        bucket.latencies.push(ms);
        // 4xx counts as an error here: a load test measuring rejected requests is measuring nothing.
        if (res.statusCode >= 400) bucket.errors += 1;
        done += 1;
        hit();
      });
    },
  );
  req.on('error', () => {
    stats.get(scenario.name).errors += 1;
    done += 1;
    hit();
  });
  if (payload) req.write(payload);
  req.end();
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

console.log(
  `Scenario load: ${concurrency} conns × ${durationSec}s → ${baseUrl}\n` +
    `Mix: ${SCENARIOS.map((s) => `${s.name} ${Math.round((s.weight / total) * 100)}%`).join(', ')}\n`,
);
for (let i = 0; i < concurrency; i += 1) hit();

setTimeout(() => {
  const rows = [];
  let breached = 0;

  for (const scenario of SCENARIOS) {
    const { latencies, errors } = stats.get(scenario.name);
    const sorted = [...latencies].sort((a, b) => a - b);
    const p95 = Math.round(pct(sorted, 95));
    const over = latencies.length > 0 && p95 > scenario.budgetMs;
    if (over) breached += 1;
    rows.push({
      scenario: scenario.name,
      requests: latencies.length,
      errors,
      p50Ms: Math.round(pct(sorted, 50)),
      p95Ms: p95,
      p99Ms: Math.round(pct(sorted, 99)),
      budgetMs: scenario.budgetMs,
      verdict: latencies.length === 0 ? 'NO DATA' : over ? 'OVER BUDGET' : 'ok',
    });
  }

  console.table(rows);
  console.log(`\nTotal: ${done} requests, ${Math.round(done / durationSec)} rps`);

  const totalErrors = rows.reduce((sum, r) => sum + r.errors, 0);
  if (totalErrors > done * 0.01) {
    console.error(`\n✖ ${totalErrors} errors (>1%) — the run is not a valid measurement.`);
    process.exit(1);
  }
  if (breached > 0) {
    console.error(`\n✖ ${breached} scenario(s) over their P95 budget.`);
    process.exit(1);
  }
  console.log('\n✔ Every scenario within budget.');
}, durationSec * 1000 + 2000);
