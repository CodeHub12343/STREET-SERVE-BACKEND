# StreetServe — Logging, Monitoring & Observability

> Structured logging, metrics, tracing, alerting, and the audit trail — from day one, per the docs ("structured logging + APM from day one").
> Companion: [SECURITY_GUIDELINES.md](SECURITY_GUIDELINES.md), [BACKGROUND_JOBS.md](BACKGROUND_JOBS.md), [ERROR_HANDLING_STRATEGY.md](ERROR_HANDLING_STRATEGY.md).

---

## 1. Structured Logging

- **Library:** `pino` (fast, JSON). No `console.log` in app code (lint-enforced).
- **Format:** JSON, one event per line, with a stable base schema:
  ```jsonc
  { "level","time","requestId","correlationId","userId?","role?",
    "module","event","msg","durationMs?","meta":{...} }
  ```
- **Correlation:** `requestId` (per HTTP request) + `correlationId` (spans request → emitted events → jobs → socket emits), propagated via `AsyncLocalStorage`. A single user action is traceable end-to-end across the API, the queue, and the worker.
- **Levels:** `error` (needs attention), `warn` (degraded/retried), `info` (state transitions, money events), `debug` (dev only).
- **Redaction (mandatory):** never log secrets, tokens, raw card/bank data, full ID documents, OTP codes, or full phone/email. `pino` redaction paths configured centrally; contact info hashed/truncated in logs.
- **Retention:** app logs shipped to a managed sink (e.g., Datadog / Grafana Loki / CloudWatch); retained per policy, separate from the immutable audit trail.

---

## 2. The Audit Trail (distinct from logs)

Logs are operational and rotate; the **audit trail is immutable, append-only, and durable** in MongoDB (`audit_logs`) — it is a compliance and financial-integrity artifact, not a debugging aid.

Every one of these writes an audit entry `{ actor_id, actor_role, action, entity_type, entity_id, reason, metadata, created_at }`:
- Payout issued / held / released / reversed.
- Settlement written.
- Dispute opened / evidence / resolved.
- Trust Score change (with formula_version + reason).
- Role grant/revoke, admin elevation.
- Account suspension.
- Fee-schedule change.
- Any admin action on another user's resource.

Maps to NFR **Auditability** ("all Trust Score changes, disputes, and payouts immutably logged"). Never mutated; corrections are new entries.

---

## 3. Metrics (Prometheus / OpenTelemetry)

Exposed at `/metrics` (internal-only). Categories:

**RED (per endpoint):** Request rate, Error rate, Duration (histogram → P50/P95/P99).
**Business/SLA metrics (the docs' named alerts):**

| Metric | Why (from docs §7) |
|---|---|
| `wave_down_sla_breach_rate` | Wave-downs expiring unanswered |
| `settlement_processing_latency` | Financial correctness path health |
| `dispute_sla_breach_count` | Disputes past 5-business-day target |
| `live_session_staleness_rate` | Pins not updating (core value prop) |
| `payout_success_rate` / `reconciliation_drift` | Money integrity vs Stripe |
| `oversell_reject_count` | Guard firing / abuse signal |
| `fraud_flags_open` | Ping/spot-me/duplicate anomalies |
| `ping_tip_qualification_rate` | Ping-economy health (real vs farmed) |

**Infra metrics:** Mongo op latency / connection pool / replica lag; Redis latency / memory / evictions; BullMQ queue depth / failure / DLQ size; Socket.IO connected clients / room counts / adapter latency; event-loop lag; process memory/CPU.

---

## 4. Tracing

- OpenTelemetry spans across HTTP → service → Mongo/Redis → external (Stripe/KYC) → jobs.
- Trace id == `correlationId`, so a slow settlement or a failed payout is one trace from request to Stripe call to job.
- Sampling: 100% on error/financial paths; head-sampled elsewhere to control cost.

---

## 5. Health & Readiness

| Endpoint | Checks |
|---|---|
| `/healthz` | Process alive (liveness probe) |
| `/readyz` | Mongo ping, Redis ping, (shallow) Stripe reachability — gates traffic/rollout |

Used by the platform for rolling deploys and autoscaling; a failing `/readyz` pulls the instance from the LB without dropping in-flight work (graceful).

---

## 6. Alerting

Routed to on-call (page) vs. Slack/email (notice) by severity:

**Page (immediate):**
- Reconciliation drift (ledger ≠ Stripe).
- Settlement/payout failure or DLQ growth.
- Error rate spike (5xx) or P95 breach on money endpoints.
- Mongo primary unreachable / replica lag high.
- Live-session staleness rate spike (realtime broken).

**Notice:**
- Wave-down SLA breach rate rising.
- Dispute SLA approaching breach.
- Fraud-flag queue growth / anomaly (spike in Spot Me from new accounts — docs §6).
- Ping-budget low-balance patterns.
- Elevated 429s (possible abuse or misconfigured limits).

Alert thresholds are config-driven and tuned against the NFR targets (P95 <300ms reads / <800ms writes, 99.5% uptime).

---

## 7. Dashboards (pilot set)

1. **Realtime health** — connected sockets, staleness rate, pin-update latency, per-cell fan-out.
2. **Money** — transaction volume, settlement latency, payout success, reconciliation drift, refund/dispute rate.
3. **API RED** — rate/error/duration per module, top slow endpoints.
4. **Fraud & Trust** — open fraud flags, oversell rejects, ping qualification rate, Trust Score recompute lag.
5. **Infra** — Mongo/Redis/BullMQ/queue depths, event-loop lag, memory.
6. **SLA compliance** — wave-down + dispute SLA adherence.

---

## 8. Operational Practices
- **Every log line and metric carries `correlationId`** — no orphan telemetry.
- **Financial events log at `info` and audit-write** — double-recorded (operational + immutable).
- **Runbooks** linked from each page-level alert (what it means, first checks, escalation).
- **Load test before multi-city expansion** on the realtime/geospatial paths, capturing baseline metrics to alert against (docs §7).
- **Post-incident:** every page-level incident gets a written follow-up; recurring ones feed the risk register.
