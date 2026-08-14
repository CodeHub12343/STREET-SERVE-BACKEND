# StreetServe — Realtime Architecture (Socket.IO + Redis)

> Live pins, queue updates, order status, notifications, and messaging over Socket.IO, scaled across instances with the Redis adapter.
> Companion: [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md) §3.2/§5, [BACKGROUND_JOBS.md](BACKGROUND_JOBS.md).

---

## 1. Why Redis Adapter Is Non-Negotiable

The docs state it plainly: the Redis adapter is "not optional the moment you run more than one server instance (which you will, for uptime)." A location update handled by instance A must reach a subscriber connected to instance B. `@socket.io/redis-adapter` fans events across all instances via Redis pub/sub. Bake it in from day one — retrofitting is painful.

```
 client A ─ws─► Instance 1 ┐                      ┌─ Instance 2 ◄─ws─ client B
                            ├─ Redis pub/sub (adapter) ─┤
 client C ─ws─► Instance 1 ┘                      └─ Instance 3 ◄─ws─ client D
```

Requirements:
- **Sticky sessions** at the load balancer for the WebSocket upgrade (or long-polling fallback affinity).
- Redis is also the **hot location store** and the **BullMQ backing store** — one managed Redis, logically separated by key prefix / db index.

---

## 2. Namespaces & Rooms

Per docs: namespaces `/live`, `/queue/:id`, `/notifications/:userId`, `/messages/:threadId`.

| Namespace | Rooms | Purpose | Who joins |
|---|---|---|---|
| `/live` | one room per **geohash cell** (e.g. `cell:9q9p1`) | Pin add/move/remove, status changes within the viewport | Any client; joins the cells its map viewport covers |
| `/queue` | `queue:<ownerId>` | Position/discount/ETA/pop-up updates | Customers in that queue + the vendor |
| `/notifications` | `user:<userId>` | Per-user push-equivalent in-app events | The authenticated user |
| `/messages` | `thread:<threadId>` | Live message delivery + read receipts | The two thread participants |

**Geohash-bucketed subscription (the scalability keystone):** a client subscribes only to the cells currently in view, not a global firehose. As the map pans, it leaves/joins cells. Broadcast fan-out for a moving vendor is bounded to the subscribers of its current cell (+ neighbor cells for edge continuity), independent of total user count. This is what lets the design target **10k concurrent live sessions per metro** without re-architecture (NFR Scalability).

---

## 3. Connection Lifecycle & Auth

1. Client connects with the same access JWT in the handshake (`auth.token`).
2. `socketAuth` middleware verifies the JWT (JWKS), loads the Principal, **rejects suspended accounts**, attaches `socket.data.principal`.
3. **Room authorization on every join** — the same three-layer authz as HTTP:
   - `/queue:<ownerId>` — must be a participant or the owner.
   - `/messages:thread:<id>` — must be a thread participant.
   - `/notifications:user:<id>` — must equal `principal.userId`.
   - `/live:cell:*` — public read is allowed; write (location) never comes from arbitrary clients.
4. Heartbeats/timeouts detect dead connections; on disconnect, the vendor's live session goes stale via the sweep (below), not instantly (avoids flapping on brief network drops).

> **Never trust the client for authoritative state.** Location ticks from a vendor socket are validated (owns an active session, plausible movement) before broadcast; queue position, discounts, and money are always server-computed and pushed — the socket is a delivery channel, not an authority.

---

## 4. Location Ingest & Broadcast Path (hot path)

```
vendor app ──(socket: location tick, ~every few s)──► Instance
   → validate (owns active session; plausible jump)
   → write Redis: geo:live:<sessionId> = {lat,lng,status,ts}  (TTL ~60s)
   → update geohash membership set for the cell
   → throttle: persist snapshot to Mongo live_sessions ~every 10s (FR-1.2)
   → emit to room live:cell:<geohash> : "pin:update"
   → adapter fans to all instances → subscribers render within 3s (FR-1.2)
```

- **Per-second writes never hit MongoDB.** Redis is the broadcast source; Mongo holds the durable last-known snapshot + a TTL'd `location_pings` history (30-day retention).
- **Staleness handling:** a session with no tick past its TTL is treated as stale; the sweep job (see [BACKGROUND_JOBS.md](BACKGROUND_JOBS.md)) marks it and emits `pin:remove`. Graceful degradation: if Redis is briefly down, clients show last-known Mongo pins flagged "may be stale" (NFR Availability).

---

## 5. Event Catalog (server → client)

| Namespace | Event | Payload | Trigger |
|---|---|---|---|
| `/live` | `pin:update` | `{sessionId, actorId, lat, lng, status, etaMin}` | Location/status tick |
| `/live` | `pin:remove` | `{sessionId}` | Stop / stale sweep |
| `/live` | `block_party` | `{eventId, centroid, businessIds}` | Detection sweep (to opted-in nearby) |
| `/queue` | `queue:update` | `{position, discountPercent, aheadCount}` | Join/leave/reflow |
| `/queue` | `wave:accepted` | `{etaSeconds, tracking}` | Vendor accepts |
| `/queue` | `popup:delay` | `{newEta, message}` | Pop-Up event |
| `/notifications` | `notify` | `{category, title, body, deeplink}` | Any domain event → notifications module |
| `/messages` | `message:new` | `{threadId, message}` | New message |
| `/messages` | `message:read` | `{threadId, readAt}` | Read receipt |

Client → server events are minimal and all authorization-checked: `live:subscribe {cells[]}`, `live:tick {lat,lng}` (owner only), `queue:subscribe {ownerId}`, `messages:typing`.

---

## 6. Realtime ↔ Domain Event Bus

Realtime emits are driven by the internal event bus, not called ad hoc from services. A service does its transactional work, emits a domain event (e.g., `wave_down.accepted`), and a realtime subscriber translates it into the correct room emit. This keeps business logic decoupled from delivery and makes the socket layer a thin, testable projection of domain events. See [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md) §5.

---

## 7. Delivery Guarantees & Fallbacks

- Socket.IO is **best-effort** in-app delivery. For anything that matters when the app is closed, the **notifications module** also dispatches via FCM push and/or **Twilio SMS** — the reliable bridge for the four background-blocked interactions (proximity, Block Party, geofence check-in, vendor-pin-while-locked) the PWA can't do while the phone sleeps (docs §12).
- Missed-while-offline: on reconnect, the client fetches missed state via REST (queue state, unread messages, notification log) — the socket is for liveness, REST is the source of truth for catch-up.
- Safety-critical notifications (payout, dispute, verification) are never socket-only; they always also go to push/email.

---

## 8. Scaling & Operational Notes

- N stateless instances; Redis adapter; sticky WS sessions.
- Monitor: connected sockets per instance, room counts, adapter pub/sub latency, emit fan-out size, live-session staleness rate (a key alert per docs §7).
- Backpressure: cap per-cell subscriber emits; coalesce rapid location ticks (send at most ~1 render update/sec/client) to protect the client and the network.
- Namespaced Redis keys (`geo:live:*`, `bull:*`, `socket.io#*`) on one managed Redis for the pilot; split instances later if load demands.
