// Dependency-free HTTP load harness for the hot geospatial read path (/api/v1/map/nearby).
// Usage: node scripts/loadtest-http.mjs [baseUrl] [concurrency] [durationSec] [token]
// Example: node scripts/loadtest-http.mjs http://localhost:8080 200 30 "$ACCESS_TOKEN"
//
// Targets the NFR: P95 < 300ms for reads under city-scale concurrency. Reports P50/P95/P99 + RPS.
import http from 'node:http';
import https from 'node:https';

const baseUrl = process.argv[2] ?? 'http://localhost:8080';
const concurrency = Number(process.argv[3] ?? 100);
const durationSec = Number(process.argv[4] ?? 20);
const token = process.argv[5] ?? '';

const url = new URL('/api/v1/map/nearby?lat=37.6&lng=-121.0&radius=3000', baseUrl);
const client = url.protocol === 'https:' ? https : http;
const headers = token ? { authorization: `Bearer ${token}` } : {};

const latencies = [];
let errors = 0;
let done = 0;
const endAt = Date.now() + durationSec * 1000;

function hit() {
  if (Date.now() >= endAt) return;
  const start = process.hrtime.bigint();
  const req = client.get(url, { headers }, (res) => {
    res.on('data', () => {});
    res.on('end', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      latencies.push(ms);
      if (res.statusCode >= 400) errors += 1;
      done += 1;
      hit();
    });
  });
  req.on('error', () => {
    errors += 1;
    done += 1;
    hit();
  });
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

console.log(`Load: ${concurrency} conns × ${durationSec}s → ${url.href}`);
for (let i = 0; i < concurrency; i += 1) hit();

setTimeout(
  () => {
    const sorted = [...latencies].sort((a, b) => a - b);
    const rps = done / durationSec;
    console.log(JSON.stringify(
      {
        requests: done,
        errors,
        rps: Math.round(rps),
        p50Ms: Math.round(pct(sorted, 50)),
        p95Ms: Math.round(pct(sorted, 95)),
        p99Ms: Math.round(pct(sorted, 99)),
      },
      null,
      2,
    ));
    process.exit(errors > done * 0.01 ? 1 : 0);
  },
  durationSec * 1000 + 2000,
);
