# Observability instrumentation — cache-hit-rate, HANA pool acquire-latency, publish-latency percentiles

**Issue:** [#805](https://github.com/sap-tutorials/tutorials-ims/issues/805)
**Date:** 2026-07-02
**Author:** Tom Jung (design captured by Claude)
**Status:** Draft — revised after spec review round 2

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

**Public surface:**

- `counter(name)` — increments a named integer counter by 1.
- `observe(name, value)` — pushes a sample into the named histogram's reservoir.
- `gauge(name, value)` — overwrites the named gauge (latest value wins).
- `snapshot()` — returns `{ counters, gauges, histograms: { name: { count, p50, p95, p99, max } } }`. Cheap; safe to call between rotations.
- `rotate()` — called by the rollup job; returns the snapshot and atomically zeros counters + drains reservoirs.
- `emitLogLine(name, value, tags)` — one structured `cds.log('jobs/metrics-rollup').info(...)` line per rollup boundary.

**Histogram algorithm** (settled after spec review): [Vitter's Algorithm R](https://en.wikipedia.org/wiki/Reservoir_sampling#Simple:_Algorithm_R), reservoir size 2000 per metric. Uniform reservoir sampling means the samples represent the whole 5-min window rather than biasing toward the tail (as FIFO would). HdrHistogram was considered and rejected as a heavier dependency for our modest volume. Algorithm R fits in ~30 lines with zero deps and self-drains on rotation.

Three consumer paths fan out:

1. **Admin UI** — new `Metrics` view at `/admin-ui/#metrics`. Reads `AnalyticsService.MetricSnapshots` (24 h chart data) + `AnalyticsService.PublishTimings` (per-publish table) + `AdminService.getMetricsSnapshot()` action (current in-memory snapshot, 30 s polling while visible).
2. **CF logs → Splunk** — the rollup writer emits one structured `cds.log('jobs/metrics-rollup').info(...)` line per metric per 5-min boundary. Same pattern as #759 explainer-generator cost lines. Splunk / existing log scrape picks these up unchanged.
3. **`/admin/metrics/live`** — plain JSON snapshot endpoint, basic-auth-protected like other `/admin/*` custom Express routes. On-call humans curl this during incidents.

Rollup writer `srv/jobs/metrics-rollup-job.js` runs every 5 min, wrapped in `job-lock.js` (matches the existing `ngds-retry` pattern) so a 2-instance CF scale-out doesn't double-write. On each tick it:

1. Computes `windowStart = Math.floor(Date.now() / 300_000) * 300_000` — aligns to the 5-min boundary so a cron firing at 14:00:07 records `windowStart = 14:00:00`, not the raw fire time. Cross-tick idempotent if the lock skips a window.
2. Reads `metrics.snapshot()`.
3. Writes one `MetricSnapshots` row per metric per window, emits one log line per metric.
4. **Rotates the histograms** (drains the reservoir so the next window starts fresh).

**`instanceId` semantics under job-lock.** Only one instance wins the lock per tick, so `instanceId` records whichever instance won the write — but the in-memory `metrics.snapshot()` on that instance only reflects that instance's activity. This is a real limitation: with two CF instances and one lock-winner writing per tick, half the observations vanish. Two ways out; the spec picks (b) for v1:

- (a) Drop `job-lock`; use `PRIMARY KEY (windowStart, metric, instanceId)` on `MetricSnapshots` so both instances write independently. Admin-tile queries aggregate across rows.
- (b) **Keep the lock; each instance emits its snapshot to the log stream every tick (unconditional) but only the lock-winner writes to HANA with a merged snapshot.** The merge is done via a small `POST /admin/metrics/ingest` internal endpoint that the loser calls to hand its snapshot to the winner before the winner writes. **Rejected** — adds a coordination hop that could fail.

Revised choice: **(a) — drop the job-lock for the rollup writer specifically.** The rollup is idempotent per `(windowStart, metric, instanceId)`: even if both instances fire at 14:05:00.100 and 14:05:00.200 they still write to different `instanceId` rows. `PRIMARY KEY (windowStart, metric, instanceId)` gives us that constraint. Admin-tile queries `SELECT metric, AVG(value) FROM MetricSnapshots WHERE windowStart >= ? GROUP BY windowStart, metric` naturally aggregate across instances. Retention prunes on `windowStart < now() - 30d`, agnostic of instance count.

The retention job, in contrast, **does** need `job-lock` (multiple deletes are not idempotent-safe against retry storms). Retention keeps the lock; rollup drops it.

### Data model

Two new entities in [db/schema.cds](../../../db/schema.cds), appended after `PipelineLogItems`:

```cds
// Generic 5-minute rollup for counters and histograms.
// Composite primary key so both CF instances can write the same window
// independently. NOT using `cuid` because a UUID key would give no
// uniqueness guarantee on (windowStart, metric, instanceId).
@cds.persistence.table
@analytics.exposed
entity MetricSnapshots : managed {
  key windowStart  : Timestamp;                // aligned to 5-min boundary
  key metric       : String(64);               // e.g. 'content.cache.hitRate'
  key instanceId   : String(64);               // CF_INSTANCE_GUID (matches srv/lib/content-publish-session.js:15 convention)
  kind         : String(16);                   // 'counter' | 'histogram' | 'gauge'
  count        : Integer64;                    // events in window
  value        : Double;                       // for counters/gauges: sum or current
  p50          : Double;                       // histogram only
  p95          : Double;                       // histogram only
  p99          : Double;                       // histogram only
  max          : Double;                       // histogram only
  tags         : String(255);                  // reserved JSON blob for later dimensions
}

// Per-publish detail row. Written by content-publish-session on commit / abort.
// Retains `cuid` — one row per publish outcome, UUID key is fine.
// Uniqueness on sessionId prevents duplicate rows from failed-retry.
@cds.persistence.table
@analytics.exposed
@assert.unique.session : [sessionId]
entity PublishTimings : cuid, managed {
  sessionId       : String(36);                // = ContentManifest.sessionId = PipelineLog.ID — cross-links to existing runbooks
  manifestVersion : Integer;                   // matches ContentManifest.version type (Integer, verified at db/_content-shape.cds:45)
  mode            : String(16);                // 'delta' | 'full' | 'heal'
  initiator       : String(255);               // mirrors ContentManifest.initiator
  slugCount       : Integer;
  beginMs         : Integer;                   // createdAt -> firstAppendAt
  appendMsTotal   : Integer;                   // sum of all append handler wall-clocks (persisted on ContentManifest, copied here at commit)
  commitMs        : Integer;                   // commit handler wall-clock
  totalMs         : Integer;                   // createdAt -> commit response sent
  outcome         : String(16);                // 'committed' | 'aborted' | 'rejected'
}
```

Indexes: `MetricSnapshots(windowStart, metric)` for admin 24 h scans; `PublishTimings(createdAt desc)` for percentile-over-last-N-days queries.

**Cardinality budget**

- ~10 named metrics × 288 5-min windows/day × 30 d × 2 instances ≈ **~173 k `MetricSnapshots` rows lifetime**
- ~50 publishes/day × 90 d ≈ **~4.5 k `PublishTimings` rows lifetime**

Both well below existing `PipelineLog` volume.

Both entities carry `@analytics.exposed`. **Correction after spec review:** the annotation alone is NOT sufficient — [srv/analytics-service.js](../../../srv/analytics-service.js) `getExposedEntries()` iterates the compiled model AND checks that the entity is projected on `AnalyticsService`. Compare `CodeCheckSubmissions` at [db/schema.cds:661](../../../db/schema.cds#L661) which is both annotated and projected at [srv/analytics-service.cds:22](../../../srv/analytics-service.cds#L22). The spec adds two explicit projections to `srv/analytics-service.cds`:

```cds
@readonly entity MetricSnapshots as projection on ims.MetricSnapshots;
@readonly entity PublishTimings  as projection on ims.PublishTimings;
```

The service-level `@requires : 'Admin'` on `AnalyticsService` gates these to Admin role — which is what the admin-shell users hold anyway. No new auth surface.

**HANA HDI artifact convention.** This project's `db/src/` tree uses `.hdbmigrationtable` files (verified — 40+ existing files, e.g. `db/src/com.sap.developers.ims.PipelineLog.hdbmigrationtable`), NOT `.hdbtable`. `@cds.persistence.table` alone doesn't produce these — `cds build --production` compiles them from the CDS entity declarations and the deploy step (`cds up` / `mtar` production build) picks them up. New entities added to `db/schema.cds` will be emitted as `.hdbmigrationtable` files automatically by `cds build`. **The plan step for schema landing includes running `cds build --production` and verifying two new migration-table files appear in the staged `db/src/gen/` (mirroring the [[feedback_cds_build_production_not_cds_compile_for_last_dev]] pattern).**

**HANA indexes** on the new entities require sibling `.hdbindex` files (per [db/schema-ext.cds:107](../../../db/schema-ext.cds#L107) documented pattern — CDS `index` syntax is rejected by the HANA compiler). Two new files under `db/src/`:

- `db/src/IDX_METRIC_SNAPSHOTS_WINDOW.hdbindex` — `INDEX "IDX_METRIC_SNAPSHOTS_WINDOW" ON "COM_SAP_DEVELOPERS_IMS_METRICSNAPSHOTS" (WINDOWSTART, METRIC)`
- `db/src/IDX_PUBLISH_TIMINGS_CREATED.hdbindex` — `INDEX "IDX_PUBLISH_TIMINGS_CREATED" ON "COM_SAP_DEVELOPERS_IMS_PUBLISHTIMINGS" (CREATEDAT DESC)`

Both required for the admin-tile query performance.

**QA schema drift check.** [`.github/workflows/schema-drift-check.yml`](../../../.github/workflows/schema-drift-check.yml) runs `scripts/check-qa-schema-drift.ts`. Confirmed at spec-review round 2: the drift check narrows to `ENTITIES = ['JobLocks']` (per PR #52). Adding `MetricSnapshots` and `PublishTimings` to `db/schema.cds` does NOT trigger a drift error because they aren't listed in `ENTITIES`. **However**: this spec also adds two columns to `ContentManifestAspect` in [db/_content-shape.cds](../../../db/_content-shape.cds) (`appendMsTotal`, `firstAppendAt`) — a shared aspect consumed by BOTH `com.sap.developers.ims.ContentManifest` AND the QA channel's `com.sap.developers.ims.qa.ContentManifest`. Aspect-derived entities are compiler-enforced and don't need a runtime check, so the shape stays symmetric automatically — the drift check won't fire and the new columns land on both schemas equally.

Do NOT add metrics entities to `db-qa/schema.cds`. QA is a deliberately slim redirect-lookup subset (per the `check-qa-schema-drift.ts` header comment); the observability data is prod-only.

### Instrumentation points

**1. Content cache** — in [srv/lib/content-store.js:144](../../../srv/lib/content-store.js#L144) `ContentCache` class.

**Correction after spec review:** the same `ContentCache` instance stores two key namespaces — raw content keys (a bare `slug`) and `render:` prefix keys (see [content-store.js:196](../../../srv/lib/content-store.js#L196) `invalidateByPrefix('render:')`). Instrumenting inside `get()` would conflate the two, and a first-render miss is a semantically different event from a "user hit a URL and we couldn't serve them" content miss.

Counters live at the call sites, not in the class:

- Bare-`slug` cache: two counters at [content-store.js:995](../../../srv/lib/content-store.js#L995) inside `serveHandler` — `metrics.counter('content.cache.hit')` when `cached` is truthy, `metrics.counter('content.cache.miss')` on the falsy branch (before the DB fallback).
- `render:` cache: two counters at [content-store.js:896](../../../srv/lib/content-store.js#L896) inside `serveHandler`'s render branch — `metrics.counter('render.cache.hit')` and `metrics.counter('render.cache.miss')`.
- Eviction (shared across both namespaces): one counter inside the eviction `while` in `ContentCache.set()` — `metrics.counter('cache.evict')`.
- Size: `metrics.gauge('cache.bytes', this.totalBytes)` at the end of `set()`.

Hit-rate is derived at snapshot time per namespace (`content.cache.hit / (hit + miss)`), not stored — the raw denominator matters (100% over 3 requests ≠ 100% over 30 000). The admin tile shows both hit-rates side by side.

**2. HANA pool acquire-latency (passive wrapping)** — in [srv/server.js](../../../srv/server.js) at `cds.on('served')`, wrap the DB service's `run` and `tx` methods when `METRICS_DB_WRAP=true`.

**Correction after spec review (rounds 1 + 2):**

- Codebase uses **`db.tx(...)`** where `db = await cds.connect.to('db')` (9+ sites: [srv/jobs/consolidate-concepts-job.js:152](../../../srv/jobs/consolidate-concepts-job.js#L152), [srv/jobs/extract-concepts-job.js:272](../../../srv/jobs/extract-concepts-job.js#L272), [srv/jobs/materialize-co-completions.js:109](../../../srv/jobs/materialize-co-completions.js#L109), [srv/knowledge-graph-service.js:1046](../../../srv/knowledge-graph-service.js#L1046), [srv/lib/kg-graph-rebuild.js:152](../../../srv/lib/kg-graph-rebuild.js#L152), [srv/lib/kg-merge-pair.js:69](../../../srv/lib/kg-merge-pair.js#L69), and `srv/lib/category-classifier.js`, `srv/lib/repo-catalog.js`) far more than `cds.tx(...)` (4 sites). Reassigning `cds.tx` only shadows the prototype method **for the `cds` module itself** — `db.tx()` resolves via the DB service instance's own prototype chain (`Service.prototype.tx` from `@sap/cds/lib/srv/srv-tx.js`) and is untouched by patching `cds.tx`. **Fix: patch `cds.db.tx` instead** (matches the scope of the `cds.db.run` wrapper).
- `cds.tx(fn)` / `db.tx(fn)` callback form **always returns a Promise** (of `fn`'s result), never a tx object with `.run`. Verified in `@sap/cds/lib/srv/srv-tx.js:25-28`. So an `if (result.run)` branch to patch `tx.run` on the returned value is dead code. The only way to time `tx.run` inside the callback is to intercept the `tx` argument the runtime passes into `fn` — done by wrapping `db.tx` such that when called with a function, it re-wraps the passed tx to patch its `.run` before calling the user's `fn`. Object-form `db.tx()` (without argument) is never used in this codebase (grep confirmed 0 sites), so we don't need to handle it.

```js
// One-time guard — cds.on('served') can fire more than once under cds.test().
// Codebase convention: globalThis.__X_Registered sentinel
// (see feedbackBeforeHookRegistered, changelogNoisePurgeAttempted,
// navigatorCacheInvalidatorRegistered in srv/server.js).
if (globalThis.__metricsDbWrapInstalled) return;
globalThis.__metricsDbWrapInstalled = true;

// 1. Wrap cds.db.run — every non-tx query flows through here.
const originalDbRun = cds.db.run.bind(cds.db);
cds.db.run = function wrappedDbRun(...args) {
  return timeAndCount(originalDbRun(...args), 'db.acquire.ms');
};

// 2. Wrap cds.db.tx — every db.tx(fn) call flows through here.
// The runtime passes a fresh tx object into fn; we intercept and
// patch tx.run so per-statement calls inside the callback are timed.
const originalDbTx = cds.db.tx.bind(cds.db);
cds.db.tx = function wrappedDbTx(fnOrOptsOrReq, maybeFn) {
  // Signature variants: db.tx(fn), db.tx(opts, fn), db.tx(req, fn), db.tx(req).
  // All 9+ sites in this codebase use db.tx(fn). If we ever hit an
  // unexpected shape, fall through un-wrapped rather than break the caller.
  if (typeof fnOrOptsOrReq !== 'function' && typeof maybeFn !== 'function') {
    return originalDbTx(fnOrOptsOrReq);
  }
  const fn = typeof fnOrOptsOrReq === 'function' ? fnOrOptsOrReq : maybeFn;
  const firstArg = typeof fnOrOptsOrReq === 'function' ? undefined : fnOrOptsOrReq;
  const wrappedFn = async (tx) => {
    // Patch tx.run so per-statement calls inside the callback get timed.
    const originalTxRun = tx.run.bind(tx);
    tx.run = (...runArgs) => timeAndCount(originalTxRun(...runArgs), 'db.tx.run.ms');
    return fn(tx);
  };
  // Overall tx wall-clock (begin -> commit / rollback) recorded separately.
  return timeAndCount(
    firstArg === undefined ? originalDbTx(wrappedFn) : originalDbTx(firstArg, wrappedFn),
    'db.tx.ms'
  );
};

function timeAndCount(promise, metricName) {
  const started = process.hrtime.bigint();
  const finish = (isErr, err) => {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    metrics.observe(metricName, elapsedMs);
    if (isErr && /timeout|acquire/i.test(err?.message || '')) {
      metrics.counter('db.pool.timeout');
    }
  };
  promise.then(() => finish(false), (err) => finish(true, err));
  return promise;
}
```

**Metrics emitted:**

- `db.acquire.ms` — every `cds.db.run(...)` observation (query outside any tx).
- `db.tx.ms` — every `db.tx(fn)` end-to-end wall-clock (whole-tx duration).
- `db.tx.run.ms` — every `tx.run(...)` inside a tx callback (per-statement inside a tx).
- `db.pool.timeout` — counter incremented when the error message matches `/timeout|acquire/i`.

The admin tile shows `db.acquire.ms` and `db.tx.run.ms` percentiles side-by-side (raw HANA connection acquire signal) and `db.tx.ms` as a distribution of transaction durations (long-running tx signal).

**Caveats, documented in code:**

- Timing measures `run()` → resolve — conflates acquire time and query time. Separating them requires driver hooks that aren't exposed. When the pool is starved, acquire dominates; when the pool is healthy, query time dominates and blends into histogram noise. A sudden rise in the p95 with unchanged query mix is the exhaustion signal.
- Only `cds.db.run` and `cds.db.tx` are patched. Non-`db` services (e.g. `srv.run()`) go un-instrumented; those are handler-side and don't touch the HANA pool directly.
- If the runtime tx-callback signature changes in a future `@sap/cds` version, the un-wrapped fallback ensures behavior degrades to "un-timed" rather than "broken."

**3. Publish latency** — in [srv/lib/content-publish-session.js](../../../srv/lib/content-publish-session.js).

**Correction after spec review:** an in-memory Map keyed by `sessionId` would break on scale-out — the load balancer can route successive `/content/publish/append` calls to different CF instances, so the Map on instance A never sees instance B's contributions. `beginPublishSession` already acquires a `content-publish` job-lock ([srv/lib/content-publish-session.js:34](../../../srv/lib/content-publish-session.js#L34)) so publishes are serialized cluster-wide, but the append HTTP calls themselves are stateless and can hit either instance. The tally must be persisted.

Two new columns on `ContentManifestAspect` in [db/_content-shape.cds](../../../db/_content-shape.cds) (sits next to the existing `sessionId`, `lastAppendAt`):

```cds
appendMsTotal : Integer default 0;   // sum of append handler wall-clocks
firstAppendAt : Timestamp;           // for beginMs computation
```

**Aspect propagates to QA channel automatically.** `ContentManifestAspect` is a shared aspect ([db/_content-shape.cds:44](../../../db/_content-shape.cds#L44)) consumed by BOTH `com.sap.developers.ims.ContentManifest` (prod) and `com.sap.developers.ims.qa.ContentManifest` (QA). Adding columns to the aspect adds them to both schemas at compile time — no separate `db-qa/` edit needed, and no drift-check failure (aspect-derived entities are compiler-enforced, per [scripts/check-qa-schema-drift.ts:6-9](../../../scripts/check-qa-schema-drift.ts#L6) header comment). The QA publish path also gets the columns "for free" but the QA rollout writes them as zero values (the metrics module is prod-only in v1 — see § QA channel below).

Handler changes:

- `beginPublishSession` — record `createdAt`, `metrics.counter('publish.attempt')`.
- `appendToSession` — measure handler wall-clock; issue `UPDATE ContentManifest SET appendMsTotal = appendMsTotal + ?, firstAppendAt = COALESCE(firstAppendAt, ?) WHERE sessionId = ?`. Idempotent on either instance.
- `commitSession` — read the manifest row; compute `beginMs = firstAppendAt - createdAt`, `appendMsTotal` (already summed on the row), `commitMs = commit handler wall-clock`, `totalMs = commitDone - createdAt`; write one `PublishTimings` row with `outcome='committed'` (or `'rejected'` if all slugs rejected). Record `metrics.observe('publish.begin.ms' | 'publish.append.ms' | 'publish.commit.ms' | 'publish.total.ms', …)`.
- `abortSession` — write one `PublishTimings` row with `outcome='aborted'` so aborted publishes stay in the record.

The per-batch UPDATE adds one small write per append batch (~30 batches per full publish — negligible next to the batch's own inserts).

**4. Publish outcome counters** — layered on the timing rows: `publish.commit.ok`, `publish.commit.reject`, `publish.abort`.

**Not instrumented in v1** (deferred):

- Per-slug publish timing. Added later if aggregate percentiles flag a per-slug outlier.
- Query-execution time (only acquire).
- Non-content-store caches, WebSocket counts, LLM token spend.

### Admin UI surface

**Correction after spec review:** `app/admin-shell/` is a UI5 application (`sap.tnt.ToolPage`, minUI5Version 1.136.0), not Vue. Peer views are UI5 controllers at `app/admin-shell/webapp/controller/*.controller.js` (`Board.controller.js`, `Statistics.controller.js`, `TutorialDashboard.controller.js`, etc.), backed by matching `view/*.view.xml` files. Also, the route name `operations` is already taken by the Featured Tasks Fiori sub-component (`sap.tutorials.admin.operations` at [app/admin/operations](../../../app/admin/operations)) and its `pipelinelog` / `joblog` peers. The observability tile ships under a distinct route.

New peer view **`Metrics`** in the admin shell:

- `app/admin-shell/webapp/view/Metrics.view.xml`
- `app/admin-shell/webapp/controller/Metrics.controller.js`
- Route registration in `app/admin-shell/webapp/manifest.json` (`sap.ui5.routing.routes`): `{ "name": "metrics", "pattern": "metrics", "target": [{ "name": "metricsTarget", ... }] }` — mirrors the `board` / `statistics` / `tutorialdashboard` route shape.
- Side-navigation entry added to `Shell.controller.js` under the existing "Analytics" section.
- URL: `/admin-ui/#metrics`.

Three cards on one view:

1. **Content cache** — current hit-rate (big number), 24 h line chart of 5-min window hit-rates, current cache size in MB / 50 MB max, evictions per hour.
2. **HANA pool** — p50 / p95 / p99 acquire-latency current-window numbers + 24 h chart, total queries per window (throughput sanity), acquire-timeout count for last hour (red badge if > 0).
3. **Publish latency** — sortable `sap.m.Table` of last 20 publishes from `PublishTimings` with mode, initiator, slug count, total ms, and a phase-breakdown mini-bar (begin / append / commit split); footer showing aggregate p50 / p95 / p99 over last 7 days.

Chart rendering uses whatever `admin-shell` already ships (verify at implementation start; if none, use `sap.viz` or Chart.js — the Statistics view is the existing precedent).

**Data sources** (revised after spec review to reflect real AnalyticsService plumbing):

- `AnalyticsService.MetricSnapshots` (OData) for the 24 h charts.
- `AnalyticsService.PublishTimings` (OData) for the publish table.
- `GET /admin/metrics/live` for the "current" numbers on the cards (polled every 30 s while the view is visible; polling stops on route change / view unmount).

**AnalyticsService is scope `Admin`** ([srv/analytics-service.cds](../../../srv/analytics-service.cds) service-level `@requires : 'Admin'`). Admin-shell users hold the Admin role already; the OData calls flow with the XSUAA cookie session as with all other admin-shell entities. No new auth surface.

**`/admin/metrics/live` auth mismatch — resolved.** [srv/server.js:183](../../../srv/server.js#L183) applies `basicAuthMiddleware` globally after `/health`. Admin-shell views run inside the approuter under XSUAA and cannot easily add a `Authorization: Basic ...` header to a fetch. Two options; the spec picks (b):

- (a) Route `/admin/metrics/live` through the approuter with an XSUAA route so the shell fetches with the SSO cookie. Requires `xs-app.json` edit and destination remapping.
- (b) **Move the "live snapshot" surface off `/admin/metrics/live` and onto an `AdminService` unbound action `getMetricsSnapshot`** (returning the same JSON shape). Admin-shell already talks to `AdminService` via OData with XSUAA cookies; no new auth path, no basic-auth from a browser. The `/admin/metrics/live` Express route stays for on-call `curl` (basic-auth) and for CF log correlation.

Under (b), the admin tile calls `GET /admin/getMetricsSnapshot()` (**function**, not action — CAP `function` is GET + read-only, matches the `getNotificationConfig` / `getEventStatistics` / `getBoardStatistics` pattern in [srv/admin-service.cds](../../../srv/admin-service.cds)) with the XSUAA session; on-call humans still `curl /admin/metrics/live -u tech:pass` for the same data. Both routes call the same underlying `metrics.snapshot()`.

**Late-bind trap for `/admin/metrics/live`.** [srv/server.js:63-70](../../../srv/server.js#L63) documents the exact problem for `/admin/analytics/*`: AdminService's OData adapter mounts at `/admin` and intercepts everything below it as `AdminService.<path>`, so registering `app.get('/admin/metrics/live', ...)` naively during `bootstrap` would be shadowed by the OData adapter. Fix pattern (same as `/admin/analytics/*` reservation stub at [srv/server.js:63](../../../srv/server.js#L63)):

```js
// bootstrap: register a stub reservation so OData adapter doesn't claim the path
let liveMetricsHandler = (req, res) => res.status(503).json({ error: 'not ready' });
app.get('/admin/metrics/live', (req, res) => liveMetricsHandler(req, res));

// served: swap in the real handler once metrics module is ready
liveMetricsHandler = async (req, res) => { /* basicAuth check + metrics.snapshot() */ };
```

**Feature-flag visibility to the UI (spec review Should-fix #3).** Env vars are process-scope and not visible to the browser bundle. The `getMetricsSnapshot` action includes `{ dbWrapEnabled: process.env.METRICS_DB_WRAP === 'true' }` in its response. The pool card renders "not yet enabled" when `dbWrapEnabled` is false. Same field appears in `/admin/metrics/live`.

No admin CRUD. Metrics view is read-only. Counters reset on `cf restart` (in-memory).

### Structured log lines

At each 5-min rollup boundary, one line per metric:

```
{"metric":"content.cache.hitRate","value":0.87,"kind":"counter","windowStart":"2026-07-02T14:00:00Z","instanceId":"..."}
```

Emitted via `cds.log('jobs/metrics-rollup').info(JSON.stringify({...}))` — matches the `jobs/cleanup` tag convention at [srv/jobs/cleanup.js:5](../../../srv/jobs/cleanup.js#L5). **Not** emitted per-event — cache hits at ~1000/hour would drown the log stream. Splunk / existing CF log scrape picks these up without new sink configuration.

## QA channel

The QA channel (`srv-qa`) is prod-parallel but slim (per [[feedback_srv_qa_cp_list]]). This spec is **v1 prod-only** for the instrumentation and admin surface:

- `srv-qa` does NOT get `srv/lib/metrics.js`, the DB wrapper, the rollup job, the admin routes, or the Metrics view.
- The two new `ContentManifestAspect` columns (`appendMsTotal`, `firstAppendAt`) land on the QA schema automatically via the shared aspect. QA publish-append handlers do not populate them (they stay at their `default 0` / null); no code change in `srv-qa` needed.
- The two new entities (`MetricSnapshots`, `PublishTimings`) land on the prod schema only.

If QA-side publish timing ever becomes valuable, it's a follow-up spec — cheap to add later since the schema columns already exist.

## Rollout

Two PRs, deliberately. The DB wrapper is the one piece that could theoretically slow every request; we observe it in isolation from the rest.

**PR 1 — Everything except the DB wrapper.**
Schema (`MetricSnapshots`, `PublishTimings`, two new `.hdbindex` files, two new `ContentManifest` columns), `srv/lib/metrics.js` module, cache-hit instrumentation, publish timing instrumentation, rollup job (no `job-lock`), retention cleanup (with `job-lock`), `AnalyticsService` projections, `AdminService.getMetricsSnapshot` action, `/admin/metrics/live` Express route, admin-shell UI5 Metrics view. `METRICS_DB_WRAP` stays `false` — the pool card renders "not yet enabled" (the response flag `dbWrapEnabled: false` drives this). Deploy this alone. Verify one full day of rollup rows accumulates across both CF instances.

**PR 2 — DB wrapper.**
Enables passive wrapping of both `cds.db.run` and `cds.tx` (so `tx.run` inside `cds.tx(async (tx) => …)` blocks is instrumented too). Metrics: `db.acquire.ms` (direct `cds.db.run` timings), `db.tx.ms` (whole-tx wall-clock), `db.pool.timeout` (counter for pool-exhaustion errors). Flip `METRICS_DB_WRAP=true` on DEV in `cf set-env`, watch for regression in p95 request latency, flip on QA + PROD.

## Feature flags

Two env vars, both `cf set-env` — not credstore (non-secret operational toggles):

- **`METRICS_ENABLED`** (default `true`) — master switch. When `false`, `metrics.counter/observe/gauge` become no-ops (early-return before any state mutation) AND the rollup job skips its tick AND the DB wrapper is not installed at `served` time. This avoids paying the promise-chain overhead on every query when metrics are off — a `.then/.catch` on every `db.run` is not free even if the callback no-ops.
- **`METRICS_DB_WRAP`** (default `false` for first deploy, then flipped on) — governs the DB / tx wrapper specifically. `false` = don't install the wrapper at all. `true` = install once (guarded by `globalThis.__metricsDbWrapInstalled`). Reversible in one `cf set-env` + `cf restart`.

Both flags are surfaced in the `getMetricsSnapshot` / `/admin/metrics/live` response so the admin tile can render "not yet enabled" states without the browser knowing env vars.

## Error handling

The metrics module has one nasty failure mode: **instrumentation crashes the thing it's measuring**. A throw inside the DB wrapper would 500 every request. So `srv/lib/metrics.js` **swallows-and-logs by default** — normally a lint violation ([[feedback_silent_swallow_hides_dead_code]]), but here silent-swallow is correct: the alarm surface is "we notice observability disappeared," not "we crash serving tutorials."

- Every public call (`counter`, `observe`, `gauge`, `snapshot`, `emitLogLine`) wrapped in `try { … } catch (err) { rateLimitedWarn(err.message); }`.
- **`snapshot()` returns a stable empty shape** (`{ counters: {}, gauges: {}, histograms: {} }`) when `METRICS_ENABLED=false` or when an internal error prevents populating it — the admin tile renders "no data yet" rather than needing a two-mode render path.
- One-per-minute rate-limit on the warn log so a broken metric doesn't drown the log stream (same one-liner pattern as `srv/lib/ip-rate-limit.js`).
- Rollup job wraps its HANA write in `try/catch`: on write failure, the log line still emits (Splunk path still works), the next tick starts a fresh window (no retry-forever queue).
- DB-wrapper `promise.then/catch` is defensive so a throw in the `.then` callback never affects the returned promise.

## Testing

**Unit tests** in [test/unit/](../../../test/unit/):

- `metrics.test.js` — counter increments; Algorithm R reservoir math (feed known distribution, assert p50 / p95 / p99 stay within tolerance across independent runs); rotation atomically zeros counters and drains reservoirs; snapshot shape; no-op behavior when `METRICS_ENABLED=false`; swallow-and-log on injected throw.
- `content-cache-metrics.test.js` — call `serveHandler` code paths for both hit and miss on the bare-slug cache AND the `render:` cache; assert counters land under the correct namespace and don't cross-pollute.
- `db-wrap.test.js` — with `METRICS_DB_WRAP=true`, wrapping is applied exactly once even when `cds.on('served')` fires twice (single-application guard). Test exercises `const db = await cds.connect.to('db'); await db.tx(async (tx) => await tx.run(SELECT.one.from('...')));` and asserts BOTH `db.tx.ms` AND `db.tx.run.ms` histograms record samples (the actual codebase pattern — verified in `srv/lib/kg-merge-pair.js` etc.). Bare `cds.db.run(...)` records `db.acquire.ms`. Injected throw in the `.then` callback does not affect the returned promise's resolution.

**Hybrid tests** in [test/hybrid/](../../../test/hybrid/) (real HANA via `cds bind --exec`, `__TEST__` prefix, `_guard.js` write-safety):

- `metrics-rollup.test.js` — seed counters + histograms, invoke the rollup handler function directly, assert `MetricSnapshots` rows appear with `windowStart` floored to 5-min boundary and expected percentile values; assert histograms are drained after rotation; assert `PRIMARY KEY (windowStart, metric, instanceId)` allows two simulated instances to write the same window without collision.
- `publish-timings.test.js` — begin → append (twice, simulating two batches) → commit through the real HANA pool with a stub `sessionId`. Assert one `PublishTimings` row is written with `sessionId` populated, `outcome='committed'`, and plausible non-zero `beginMs` / `appendMsTotal` / `commitMs` / `totalMs`. Assert `ContentManifest.appendMsTotal` was incremented on each append.
- `analytics-projection.test.js` — issue OData `GET /analytics/MetricSnapshots?$top=1` and `GET /analytics/PublishTimings?$top=1` with Admin token; assert 200 + JSON body shape. Confirms the `analytics-service.cds` projection is wired.

**Smoke tests** in [test/smoke/](../../../test/smoke/) (HTTP against deployed):

- `metrics-live.smoke.js` — `GET /admin/metrics/live` (with basic-auth) returns a non-empty snapshot with expected top-level keys (`snapshot`, `instanceId`, `uptimeSec`, `dbWrapEnabled`, `generatedAt`).
- `metrics-action.smoke.js` — `POST /admin/getMetricsSnapshot` (XSUAA Admin token) returns the same shape; verifies the AdminService action path used by the admin-shell.

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

## Revision log

**Round 1 (2026-07-02) — spec review by `general-purpose` agent (agentId `a1cf146080d5550f4`).** Five Critical + seven Should-fix issues found; all addressed:

- Admin UI is UI5 (`app/admin-shell/webapp/controller/*.controller.js`), not Vue — rewrote § Admin UI surface. Also renamed the route from `operations` (collided with existing Featured Tasks Fiori sub-component) to `metrics`.
- `@analytics.exposed` alone doesn't route; added explicit `@readonly entity … as projection on …` block for `analytics-service.cds` and noted the service-level `@requires : 'Admin'` gate.
- `cds.db.run` wrapper misses `tx.run` (39+ sites); expanded to wrap both `cds.db.run` and `cds.tx()`, emitting separate `db.acquire.ms` and `db.tx.ms` metrics.
- Added `globalThis.__metricsDbWrapInstalled` guard to prevent double-wrap when `cds.on('served')` re-fires (matches existing `srv/server.js` sentinel convention).
- In-memory publish-timing tally would break on load-balanced append batches; moved the running tally onto two new `ContentManifest` columns (`appendMsTotal`, `firstAppendAt`) so timing survives instance-swap mid-publish.
- HANA indexes require `.hdbindex` files, not CDS `index` syntax; added two files (`IDX_METRIC_SNAPSHOTS_WINDOW`, `IDX_PUBLISH_TIMINGS_CREATED`).
- Feature flag state needs to reach the browser; surfaced `dbWrapEnabled` in the `getMetricsSnapshot` response and made `AdminService.getMetricsSnapshot` the primary UI path (XSUAA-friendly), with `/admin/metrics/live` retained for on-call `curl`.
- `windowStart` alignment: rollup writer must `Math.floor(now / 300_000) * 300_000`.
- `MetricSnapshots` needs `PRIMARY KEY (windowStart, metric, instanceId)` and the rollup writer drops `job-lock` (both instances write independently); retention keeps `job-lock`.
- `ContentCache` counters moved out of the class (which stores two key namespaces) into the `serveHandler` call sites so `content.cache.*` and `render.cache.*` don't cross-pollute.
- Reservoir algorithm settled: Vitter's Algorithm R, size 2000 per metric, drains on rotation.
- `PublishTimings.sessionId` added for free cross-link to `PipelineLog.ID`.
- `METRICS_ENABLED=false` skips wrapper installation entirely (not "install and short-circuit inside") to avoid promise-chain overhead when off.

**Round 2 (2026-07-02) — same reviewer, re-review of revised spec.** Four Critical + six Should-fix + three Nice-to-have found; all addressed:

- Reassigning `cds.tx` only shadows the prototype for the `cds` module itself and does NOT reach `db.tx()` (verified via `@sap/cds/lib/srv/srv-tx.js` and 9+ `db.tx` call sites in the codebase). Repointed the wrapper at `cds.db.tx` and clarified: the runtime passes a tx object into the callback, so `db.tx(fn)` is wrapped by intercepting `fn`, patching `tx.run` inside the wrapping closure, then calling `fn(tx)`. Object-form `db.tx()` never appears in this codebase (grep verified 0 sites) — dropped from the wrapper.
- Introduced three timing metrics instead of two: `db.acquire.ms` (bare `cds.db.run`), `db.tx.ms` (whole `db.tx(fn)` wall-clock), `db.tx.run.ms` (per-statement `tx.run` inside a callback). Admin tile shows all three.
- `cuid` + composite primary key was contradictory (`cuid` provides `key ID : UUID`). Dropped `cuid` on `MetricSnapshots` in favour of the natural composite key `(windowStart, metric, instanceId)`. Kept `cuid` on `PublishTimings` and added `@assert.unique.session : [sessionId]` to prevent failed-retry duplicates.
- HDI file convention is `.hdbmigrationtable` (verified — 40+ existing files), produced by `cds build --production` from CDS declarations. Spec cross-references [[feedback_cds_build_production_not_cds_compile_for_last_dev]] for the deploy path.
- QA schema drift check narrows to `ENTITIES = ['JobLocks']` (per PR #52 header comment on `scripts/check-qa-schema-drift.ts`), so new prod-only entities don't trip it. The two `ContentManifestAspect` columns propagate to QA schema automatically via the shared aspect and are compiler-enforced symmetric — no separate QA edit and no drift error. Added a "QA channel" section calling out the prod-only scope of v1 instrumentation and the accidental QA-side column landing.
- `getMetricsSnapshot` declared as CAP `function` (GET, read-only) not `action` (POST) to match the sibling read-only pattern (`getNotificationConfig`, `getEventStatistics`, etc.) in [srv/admin-service.cds](../../../srv/admin-service.cds).
- Added late-bind reservation pattern for `/admin/metrics/live` so it isn't shadowed by AdminService's OData adapter at `/admin/*` — same pattern as the existing `/admin/analytics/*` reservation at [srv/server.js:63](../../../srv/server.js#L63).
- Log tag consistency: single tag `cds.log('jobs/metrics-rollup')` everywhere (matches `jobs/cleanup` convention).
- Tests now exercise `db.tx(async (tx) => await tx.run(...))` (the actual codebase pattern) and assert BOTH `db.tx.ms` and `db.tx.run.ms` histograms record samples.
- `instanceId` sourced from `process.env.CF_INSTANCE_GUID` with `local-${process.pid}` fallback — matches `srv/lib/content-publish-session.js:15` convention.
- `snapshot()` returns a stable empty shape when disabled or errored so the admin tile has a single render path.
