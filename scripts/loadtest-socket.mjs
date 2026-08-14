// Realtime load harness.
//
// Two scenarios, because the platform has two very different realtime shapes:
//
//   subscribers (default) — N concurrent live-map READERS on /live. Validates the geohash-bucketed
//                           subscription model at city scale (NFR: 10k concurrent sessions/metro).
//   courier               — N concurrent deliveries, each a driver WRITING a position every few
//                           seconds to one watching customer. This is a sustained write profile,
//                           which nothing else on the platform produces. See SWEEP_LOAD_MODEL.md
//                           §"Realtime write load".
//
// Requires socket.io-client (add as a devDependency to run): npm i -D socket.io-client
//
// Usage:
//   node scripts/loadtest-socket.mjs [baseUrl] [clients] [token]
//   node scripts/loadtest-socket.mjs [baseUrl] [deliveries] [token] --scenario=courier [--hz=0.5] [--seconds=60]
//
// NOTE: the courier scenario targets the `/delivery` namespace, which lands with DAN-6 (Phase 5e).
// It is written first on purpose — the point is to size the ping ceiling while it is still cheap to
// change, rather than discovering it on the first busy Saturday.
const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')),
);
const positional = args.filter((a) => !a.startsWith('--'));

const baseUrl = positional[0] ?? 'http://localhost:8080';
const count = Number(positional[1] ?? 500);
const token = positional[2] ?? '';
const scenario = flags.scenario ?? 'subscribers';

let io;
try {
  ({ io } = await import('socket.io-client'));
} catch {
  console.error('socket.io-client not installed. Run: npm i -D socket.io-client');
  process.exit(1);
}

const connect = (namespace) =>
  io(`${baseUrl}${namespace}`, { transports: ['websocket'], auth: { token }, reconnection: false });

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// ─── subscribers ────────────────────────────────────────────────────────────────────────────
async function runSubscribers() {
  let connected = 0;
  let failed = 0;
  const latencies = [];
  const sockets = [];

  for (let i = 0; i < count; i += 1) {
    const start = Date.now();
    const socket = connect('/live');
    socket.on('connect', () => {
      connected += 1;
      latencies.push(Date.now() - start);
      // Subscribe to a handful of geohash cells in view, like a real client.
      socket.emit('live:subscribe', { cells: ['9q9p1', '9q9p3'] });
    });
    socket.on('connect_error', () => {
      failed += 1;
    });
    sockets.push(socket);
  }

  await new Promise((r) => setTimeout(r, 15_000));
  const mean = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;
  console.log(
    JSON.stringify({ scenario, clients: count, connected, failed, meanConnectMs: mean }, null, 2),
  );
  for (const s of sockets) s.close();
  return failed > count * 0.02 ? 1 : 0;
}

// ─── courier ────────────────────────────────────────────────────────────────────────────────
/**
 * Each delivery is a producer socket emitting `delivery:position` plus a consumer socket in the same
 * `delivery:{id}` room. The number that matters is **fan-out latency** — producer emit to consumer
 * receipt — because a tracker whose pin lags the road is worse than no tracker at all.
 *
 * Emits carry a client timestamp, so a late frame is measurable rather than merely absent.
 */
async function runCourier() {
  const hz = Number(flags.hz ?? 0.5); // positions per second, per delivery
  const seconds = Number(flags.seconds ?? 60);
  const expectedPerDelivery = Math.floor(hz * seconds);

  let connected = 0;
  let failed = 0;
  let sent = 0;
  let received = 0;
  const fanoutMs = [];
  const sockets = [];
  const timers = [];

  for (let i = 0; i < count; i += 1) {
    const deliveryId = `loadtest_delivery_${i}`;

    const consumer = connect('/delivery');
    consumer.on('connect', () => {
      connected += 1;
      consumer.emit('delivery:watch', { deliveryId });
    });
    consumer.on('connect_error', () => {
      failed += 1;
    });
    consumer.on('delivery:position', (payload) => {
      received += 1;
      if (payload?.sentAt) fanoutMs.push(Date.now() - payload.sentAt);
    });

    const producer = connect('/delivery');
    producer.on('connect', () => {
      connected += 1;
      // A driver moving roughly north at street speed. The exact path does not matter; the write
      // rate does.
      let lat = 37.77;
      timers.push(
        setInterval(() => {
          lat += 0.0002;
          producer.emit('delivery:position', {
            deliveryId,
            lng: -122.42,
            lat,
            sentAt: Date.now(),
          });
          sent += 1;
        }, 1000 / hz),
      );
    });
    producer.on('connect_error', () => {
      failed += 1;
    });

    sockets.push(consumer, producer);
  }

  await new Promise((r) => setTimeout(r, seconds * 1000));
  for (const t of timers) clearInterval(t);
  // Let the last frames land before measuring.
  await new Promise((r) => setTimeout(r, 2_000));

  const sorted = [...fanoutMs].sort((a, b) => a - b);
  const deliveredPct = sent ? Math.round((received / sent) * 100) : 0;

  console.log(
    JSON.stringify(
      {
        scenario,
        deliveries: count,
        hz,
        seconds,
        socketsOpened: count * 2,
        connected,
        failed,
        positionsSent: sent,
        positionsReceived: received,
        expectedApprox: count * expectedPerDelivery,
        deliveredPct,
        fanoutMs: {
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          p99: percentile(sorted, 99),
          max: sorted.at(-1) ?? 0,
        },
      },
      null,
      2,
    ),
  );

  for (const s of sockets) s.close();

  // Budget: essentially nothing may be dropped, and p95 fan-out stays inside a second. A tracker one
  // second behind is still honest; five seconds behind is a lie about where the driver is.
  const ok = failed <= count * 0.02 && deliveredPct >= 99 && percentile(sorted, 95) <= 1000;
  return ok ? 0 : 1;
}

const exitCode = scenario === 'courier' ? await runCourier() : await runSubscribers();
process.exit(exitCode);
