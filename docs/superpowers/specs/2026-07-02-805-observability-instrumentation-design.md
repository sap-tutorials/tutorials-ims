# Observability instrumentation — cache-hit-rate, HANA pool acquire-latency, publish-latency percentiles

**Issue:** [#805](https://github.com/sap-tutorials/tutorials-ims/issues/805)
**Date:** 2026-07-02
**Author:** Tom Jung (design captured by Claude)
**Status:** Draft — pending spec review

## Problem

Three related observability gaps in the CAP srv runtime:

1. **Content-cache** in [srv/lib/content-store.js:144](../../../srv/lib/content-store.js#L144) (`ContentCache`, 50 MB bounded LRU) has no hit / miss / eviction counters. When `/tutorials/*` is slow, there is no way to distinguish "cache is cold and every request hits HANA" from "cache is warm but HANA is slow."
2. **HANA connection pool** has no exhaustion probe. The `@sap/cds` HANA service exposes `/health/db` (`SELECT 1 FROM DUMMY`) as a liveness check, but no timing signal for how long callers wait to *acquire* a connection when the pool is saturated by long-running queries (embedding writes, KG rebuild, bulk-sql progress recompute).
3. **Publish latency** is recorded per-run as a single `PipelineLog.durationMs` wall-clock. There is no per-phase attribution (begin / append / commit) and no percentile view across runs — so a regression that adds 40 s to `commit` is invisible until someone notices publishes feel slow.

The `@opentelemetry/*` deps in `package.json` are unused; no `srv/lib/metrics.js` exists today (some earlier specs reference it aspirationally). The platform emits no operational metrics of any kind.

## Scope

**In scope**

- New shared metrics producer module `srv/lib/metrics.js` (counters, gauges, histograms with bounded reservoir; in-memory).
- Instrumentation at four call sites: `ContentCache` (hit / miss / evict / bytes), `cds.db.run` wrapper for HANA acquire-latency, `content-publish-session.js` for per-phase publish timing, publish-outcome counters.
- Two new HANA entities (`MetricSnapshots`, `PublishTimings`) under `com.sap.developers.ims`, both `@analytics.exposed`.
- 5-min rollup job (`srv/jobs/metrics-rollup-job.js`) with `job-lock.js` for scale-out safety.
- `GET /admin/metrics/live` JSON endpoint on the srv (basic-auth).
- New Vue view `app/admin-shell/src/views/Operations.vue` — three cards (cache, pool, publish).
- Structured log lines at each rollup boundary (Splunk / CF log scrape path).
- Retention job (`MetricSnapshots` 30 d, `PublishTimings` 90 d) folded into existing `srv/jobs/scheduler.js` cleanup cron.

**Out of scope (explicit)**

- OpenTelemetry OTLP-gRPC wiring / external OTel collector export.
- Alerting rules or thresholds — this spec ships data; alerting is a separate concern.
- Per-slug publish timing rows (rejected in brainstorm Q3 in favour of per-phase).
- Synthetic active pool probe (rejected in brainstorm Q4 in favour of passive wrapping).
- Cache-tier metrics for the `secret-resolver` 5-min TTL cache or the KG neighborhood cache — separate concerns.
- Backfill of historical publish timings from existing `PipelineLog` rows.
- WebSocket connection counts, Joule chat token spend, embedding job throughput — these have their own admin surfaces.

## Architecture

### Producer / consumer topology

Single new module **`srv/lib/metrics.js`** is the sole producer. Every subsystem that records a data point calls into it:

```js
metrics.counter('content.cache.hit')
metrics.observe('publish.commit.ms', 87)
metrics.gauge('content.cache.bytes', 1_234_567)
```

The module owns in-memory state, exposes `snapshot()`, and never talks to the database itself.

Three consumer paths fan out:

1. **Admin UI** — new `Operations` tile at `/admin-ui/#operations-display`. Reads `AnalyticsService.MetricSnapshots` (24 h chart data) + `AnalyticsService.PublishTimings` (per-publish table) + `GET /admin/metrics/live` (current in-memory snapshot, 30 s polling while visible).
2. **CF logs → Splunk** — the rollup writer emits one structured `cds.log('metrics').info(...)` line per metric per 5-min boundary. Same pattern as #759 explainer-generator cost lines. Splunk / existing log scrape picks these up unchanged.
3. **`/admin/metrics/live`** — plain JSON snapshot endpoint, basic-auth-protected like other `/admin/*` custom Express routes. On-call humans curl this during incidents; the admin UI polls it.

Rollup writer `srv/jobs/metrics-rollup-job.js` runs every 5 min, wrapped in `job-lock.js` (matches the existing `ngds-retry` pattern) so a 2-instance CF scale-out doesn't double-write. On each tick it reads `metrics.snapshot()`, writes one `MetricSnapshots` row per metric per window, emits one log line per metric, then **rotates the histograms** (drains the reservoir so the next window starts fresh).

### Data model

Two new entities in [db/schema.cds](../../../db/schema.cds), appended after `PipelineLogItems`:

```cds
// Generic 5-minute rollup for counters and histograms.
// One row per metric per window per source (host / CF instance).
@cds.persistence.table
@analytics.exposed
entity MetricSnapshots : cuid, managed {
  windowStart  : Timestamp;                    // aligned to 5-min boundary
  metric       : String(64);                   // e.g. 'content.cache.hitRate'
  kind         : String(16);                   // 'counter' | 'histogram' | 'gauge'
  count        : Integer64;                    // events in window
  value        : Double;                       // for counters/gauges: sum or current
  p50          : Double;                       // histogram only
  p95          : Double;                       // histogram only
  p99          : Double;                       // histogram only
  max          : Double;                       // histogram only
  instanceId   : String(64);                   // CF_INSTANCE_GUID or hostname
  tags         : String(255);                  // reserved JSON blob for later dimensions
}

// Per-publish detail row. Written by content-publish-session on commit / abort.
@cds.persistence.table
@analytics.exposed
entity PublishTimings : cuid, managed {
  manifestVersion : Integer;                   // FK-equivalent to ContentManifest.version
  mode            : String(16);                // 'delta' | 'full' | 'heal'
  initiator       : String(255);               // mirrors ContentManifest.initiator
  slugCount       : Integer;
  beginMs         : Integer;                   // begin -> first append received
  appendMsTotal   : Integer;                   // sum of all append handler wall-clocks
  commitMs        : Integer;                   // commit handler wall-clock
  totalMs         : Integer;                   // begin -> commit response sent
  outcome         : String(16);                // 'committed' | 'aborted' | 'rejected'
}
```

Indexes: `MetricSnapshots(windowStart, metric)` for admin 24 h scans; `PublishTimings(createdAt desc)` for percentile-over-last-N-days queries.

**Cardinality budget**

- ~10 named metrics × 288 5-min windows/day × 30 d × 2 instances ≈ **~173 k `MetricSnapshots` rows lifetime**
- ~50 publishes/day × 90 d ≈ **~4.5 k `PublishTimings` rows lifetime**

Both well below existing `PipelineLog` volume.

Both entities carry `@analytics.exposed` so the existing `AnalyticsService` ad-hoc SQL surface reads them without additional plumbing.

### Instrumentation points

**1. Content cache** — in [srv/lib/content-store.js:144](../../../srv/lib/content-store.js#L144) `ContentCache` class:

- `get()` — on hit, `metrics.counter('content.cache.hit')`; on miss, `metrics.counter('content.cache.miss')`.
- Inside the eviction `while` loop in `set()`, `metrics.counter('content.cache.evict')`.
- After the size update in `set()`, `metrics.gauge('content.cache.bytes', this.totalBytes)`.

Hit-rate is derived at snapshot time (`hit / (hit + miss)`), not stored — the raw denominator matters (100% over 3 requests ≠ 100% over 30 000).

**2. HANA pool acquire-latency (passive wrapping)** — in [srv/server.js](../../../srv/server.js) at `cds.on('served')`, wrap `cds.db.run` when `METRICS_DB_WRAP=true`:

```js
const originalRun = cds.db.run.bind(cds.db);
cds.db.run = function wrappedRun(...args) {
  const started = process.hrtime.bigint();
  const promise = originalRun(...args);
  promise.then(
    () => metrics.observe('db.acquire.ms', Number(process.hrtime.bigint() - started) / 1e6),
    (err) => {
      metrics.observe('db.acquire.ms', Number(process.hrtime.bigint() - started) / 1e6);
      if (/timeout|acquire/i.test(err?.message || '')) {
        metrics.counter('db.pool.timeout');
      }
    }
  );
  return promise;
};
```

**Caveat, documented in code:** this measures `run()` → resolve, which conflates acquire time and query time. Separating them requires driver hooks that aren't exposed. When the pool is starved, acquire dominates; when the pool is healthy, query time dominates and blends into histogram noise. A sudden rise in the p95 with unchanged query mix is the exhaustion signal.

**3. Publish latency** — in [srv/lib/content-publish-session.js](../../../srv/lib/content-publish-session.js):

- `beginPublishSession` — record `startedAt` (already on `PublishSessions.createdAt`), plus `metrics.counter('publish.attempt')`.
- `appendToSession` — accumulate handler wall-clock into an in-memory tally keyed by `sessionId` (Map; entry lifecycle bounded by session lifetime).
- `commitSession` — compute `commitMs`, `beginMs`, `appendMsTotal`, `totalMs`; write one `PublishTimings` row with `outcome='committed'` (or `'rejected'` if all slugs rejected); record `metrics.observe('publish.begin.ms' | 'publish.append.ms' | 'publish.commit.ms' | 'publish.total.ms', …)`.
- `abortSession` — write one `PublishTimings` row with `outcome='aborted'` so aborted publishes stay in the record.

**4. Publish outcome counters** — layered on the timing rows: `publish.commit.ok`, `publish.commit.reject`, `publish.abort`.

**Not instrumented in v1** (deferred):

- Per-slug publish timing. Added later if aggregate percentiles flag a per-slug outlier.
- Query-execution time (only acquire).
- Non-content-store caches, WebSocket counts, LLM token spend.

### Admin UI surface

New view **`app/admin-shell/src/views/Operations.vue`** — peer of `Board.vue`, `Statistics.vue`, `TutorialDashboard.vue`. Registered in the admin-shell router + side navigation under the existing "Analytics" section.

Three cards on one page:

1. **Content cache** — current hit-rate (big number), 24 h line chart of 5-min window hit-rates, current cache size in MB / 50 MB max, evictions per hour.
2. **HANA pool** — p50 / p95 / p99 acquire-latency current-window numbers + 24 h chart, total queries per window (throughput sanity), acquire-timeout count for last hour (red badge if > 0).
3. **Publish latency** — sortable table of last 20 publishes from `PublishTimings` with mode, initiator, slug count, total ms, and a phase-breakdown mini-bar (begin / append / commit split); footer line showing aggregate p50 / p95 / p99 over last 7 days.

Chart library matches whatever `admin-shell` already ships (avoids a new bundle — decision at implementation time; both Chart.js and D3 are already elsewhere in the tree).

Backend route **`GET /admin/metrics/live`** in [srv/server.js](../../../srv/server.js):

- Registered alongside `/health` / `/health/db`, protected by `basicAuthMiddleware`.
- Returns `{ snapshot: metrics.snapshot(), instanceId, uptimeSec, generatedAt }`.
- Polled every 30 s by the admin tile while visible; polling stops on view unmount.
- Same endpoint humans curl during incidents.

No admin CRUD. Operations is read-only. Counters reset on `cf restart` (in-memory).

### Structured log lines

At each 5-min rollup boundary, one line per metric:

```
{"metric":"content.cache.hitRate","value":0.87,"kind":"counter","windowStart":"2026-07-02T14:00:00Z","instanceId":"..."}
```

Emitted via `cds.log('metrics').info(JSON.stringify({...}))`. **Not** emitted per-event — cache hits at ~1000/hour would drown the log stream. Splunk / existing CF log scrape picks these up without new sink configuration.

## Rollout

Two PRs, deliberately. The DB wrapper is the one piece that could theoretically slow every request; we observe it in isolation from the rest.

**PR 1 — Everything except the DB wrapper.**
Schema (`MetricSnapshots`, `PublishTimings`), `srv/lib/metrics.js` module, cache-hit instrumentation, publish timing instrumentation, rollup job, retention cleanup, `/admin/metrics/live`, admin UI Operations tile. `METRICS_DB_WRAP` stays `false` — the pool card renders "not yet enabled." Deploy this alone. Verify one full day of rollup rows accumulates.

**PR 2 — DB wrapper.**
Enables passive `cds.db.run` wrapping. Flip `METRICS_DB_WRAP=true` on DEV in `cf set-env`, watch for regression in p95 request latency, flip on QA + PROD.

## Feature flags

Two env vars, both `cf set-env` — not credstore (non-secret operational toggles):

- **`METRICS_ENABLED`** (default `true`) — master switch. When `false`, `metrics.counter/observe/gauge` become no-ops and the rollup job skips its tick. Kill-switch for any incident where instrumentation itself is suspected.
- **`METRICS_DB_WRAP`** (default `false` for first deploy, then flipped on) — governs the passive `cds.db.run` wrapper specifically. Reversible in one `cf set-env` + `cf restart`.

## Error handling

The metrics module has one nasty failure mode: **instrumentation crashes the thing it's measuring**. A throw inside the DB wrapper would 500 every request. So `srv/lib/metrics.js` **swallows-and-logs by default** — normally a lint violation ([[feedback_silent_swallow_hides_dead_code]]), but here silent-swallow is correct: the alarm surface is "we notice observability disappeared," not "we crash serving tutorials."

- Every public call (`counter`, `observe`, `gauge`, `snapshot`, `emitLogLine`) wrapped in `try { … } catch (err) { rateLimitedWarn(err.message); }`.
- One-per-minute rate-limit on the warn log so a broken metric doesn't drown the log stream (same one-liner pattern as `srv/lib/ip-rate-limit.js`).
- Rollup job wraps its HANA write in `try/catch`: on write failure, the log line still emits (Splunk path still works), the next tick starts a fresh window (no retry-forever queue).
- DB-wrapper `promise.then/catch` is defensive so a throw in the `.then` callback never affects the returned promise.

## Testing

**Unit tests** in [test/unit/](../../../test/unit/):

- `metrics.test.js` — counter increments; histogram percentile math (feed known distribution, assert p50 / p95 / p99); reservoir rotation; snapshot shape; no-op behavior when `METRICS_ENABLED=false`; swallow-and-log on injected throw.
- `content-cache-metrics.test.js` — `ContentCache` hit / miss / evict counters wire through to the module.

**Hybrid tests** in [test/hybrid/](../../../test/hybrid/) (real HANA via `cds bind --exec`, `__TEST__` prefix, `_guard.js` write-safety):

- `metrics-rollup.test.js` — seed counters + histograms, invoke the rollup handler function directly, assert `MetricSnapshots` rows appear with correct `windowStart` alignment and percentile values, assert histograms are drained on rotation.
- `publish-timings.test.js` — begin → append → commit through the real HANA pool, assert one `PublishTimings` row is written with plausible non-zero `beginMs`, `appendMsTotal`, `commitMs`, `totalMs`, `outcome='committed'`.

**Smoke tests** in [test/smoke/](../../../test/smoke/) (HTTP against deployed):

- `metrics-live.smoke.js` — `GET /admin/metrics/live` (with basic-auth) returns a non-empty snapshot with expected top-level keys (`snapshot`, `instanceId`, `uptimeSec`, `generatedAt`).

**Not tested (documented):** absolute timing accuracy of the DB wrapper — timing tests on real HANA are flaky. We assert that when wrapping is enabled, the `db.acquire.ms` histogram's `count` increases in proportion to observed queries; we do not assert absolute latency numbers.

## Documentation

- New **`docs/developers/architecture/observability.md`** — module public surface, list of metrics, where they surface, how to add a new metric.
- Update **`docs/developers/operations/testing-endpoints.md`** — add `/admin/metrics/live` to the endpoint reference with basic-auth requirement.
- One-line entry in **`CLAUDE.md`** under Gotchas: `METRICS_DB_WRAP=false` default + rationale.
- One-line entry in `MEMORY.md` under the `Deploy / CF / BTP` section pointing to the feature flag pattern.

## Open questions

None at spec time. Chart library choice (Chart.js vs. D3) deferred to implementation — pick whichever `admin-shell` already bundles.

## Design decisions record

Choices captured from the brainstorm dialog, ordered as answered:

- **Q1 → A+B** — admin UI + structured log lines. Rejected OTel wiring (no BTP-side receiver today) and "just alert" (no durable trail).
- **Q2 → A** — 5-min rollup rows + live counters. Rejected per-event rows (cache-miss volume too high) and live-only (loses history on `cf restart`).
- **Q3 → A** — per-publish, per-phase timing rows. Rejected per-slug (14 k rows/day too much for a v1) and rollup-only (loses per-publish attribution).
- **Q4 → A alone** — passive `cds.db.run` wrapper. Rejected active synthetic probe (`/health/db` already covers liveness; false-negative risk when synthetic passes but real queries starve).
