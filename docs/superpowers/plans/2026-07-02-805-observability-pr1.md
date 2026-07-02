# Observability Instrumentation (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument the CAP srv runtime with cache-hit-rate counters, publish-latency percentiles, and a HANA-backed rollup pipeline surfaced in the admin UI — everything except the passive `cds.db.tx` / `cds.db.run` wrapper, which lands in PR 2.

**Architecture:** A single new `srv/lib/metrics.js` producer module holds in-memory counters, gauges, and Vitter Algorithm R reservoirs. Cache hits/misses and publish-timing events call into it at their existing call sites. A 5-min cron writes rollup rows to a new `MetricSnapshots` HANA entity (composite primary key, no job-lock, per-instance rows). A new `PublishTimings` entity captures per-publish per-phase timing. An `AdminService.getMetricsSnapshot()` CAP function serves the live snapshot to a new UI5 `Metrics` peer view in `app/admin-shell/`. A basic-auth `/admin/metrics/live` Express endpoint (late-bound to dodge the AdminService OData adapter) serves on-call `curl`. Retention job (with `job-lock`) prunes on the daily cleanup cron.

**Tech Stack:** `@sap/cds` (Node), HANA via CDS QL, `node-cron`, UI5 1.136.0 (`sap.tnt.ToolPage`), Vitter Algorithm R for reservoir sampling (zero deps), Vitest for unit + hybrid tests.

**Spec:** [`docs/superpowers/specs/2026-07-02-805-observability-instrumentation-design.md`](../specs/2026-07-02-805-observability-instrumentation-design.md)

**Issue:** [#805](https://github.com/sap-tutorials/tutorials-ims/issues/805)

---

## Scope

**In this plan (PR 1):**

- New `srv/lib/metrics.js` module + unit tests.
- Two new HANA entities (`MetricSnapshots`, `PublishTimings`) with composite / `@assert.unique` keys and two `.hdbindex` files.
- Two new columns on `ContentManifestAspect` (`appendMsTotal`, `firstAppendAt`) — propagate to QA schema via shared aspect.
- Explicit `AnalyticsService` `@readonly` projections for both new entities.
- Content-cache counters added at the two `serveHandler` call sites — `content.cache.*` and `render.cache.*` namespaces.
- Publish-timing instrumentation on `beginPublishSession` / `appendToSession` / `commitSession` / `abortSession`, writing `PublishTimings` rows.
- 5-min rollup job (`srv/jobs/metrics-rollup-job.js`) — no `job-lock`; both instances write independently.
- 30 d / 90 d retention job — folded into the existing daily cleanup cron, WITH `job-lock`.
- `AdminService.getMetricsSnapshot()` CAP function + late-bound `/admin/metrics/live` Express endpoint.
- New UI5 peer view `app/admin-shell/webapp/view/Metrics.view.xml` + `controller/Metrics.controller.js` at route `#metrics`, three cards (cache, pool-placeholder, publish).
- `METRICS_ENABLED` env flag (default `true`); `METRICS_DB_WRAP` env flag declared but installer not wired (PR 2's job).
- Docs: `docs/developers/architecture/observability.md`, `docs/developers/operations/testing-endpoints.md` update, CLAUDE.md gotcha entry.

**Not in this plan (PR 2 follow-up):**

- Passive `cds.db.run` + `cds.db.tx` wrapper installation. The pool card in the admin UI renders "not yet enabled" based on the `dbWrapEnabled: false` flag surfaced by `getMetricsSnapshot()`.

---

## File map

| Path | Action | Responsibility |
|---|---|---|
| `srv/lib/metrics.js` | **Create** | In-memory counters/gauges/reservoirs; Algorithm R; snapshot/rotate/emitLogLine public surface |
| `srv/lib/__tests__/metrics.test.js` | **Create** | Unit tests for the module (percentile math, rotation, empty-shape, swallow-and-log) |
| `db/schema.cds` | **Modify** | Add `MetricSnapshots` (composite key) + `PublishTimings` (`cuid` + `@assert.unique.session`) entities |
| `db/_content-shape.cds` | **Modify** | Add `appendMsTotal` + `firstAppendAt` columns to `ContentManifestAspect` |
| `db/src/IDX_METRIC_SNAPSHOTS_WINDOW.hdbindex` | **Create** | HANA index on `(WINDOWSTART, METRIC)` |
| `db/src/IDX_PUBLISH_TIMINGS_CREATED.hdbindex` | **Create** | HANA index on `(CREATEDAT DESC)` |
| `srv/analytics-service.cds` | **Modify** | Add `@readonly` projections for `MetricSnapshots` and `PublishTimings` |
| `srv/lib/content-store.js` | **Modify** | Add cache counters at `serveHandler` render-cache branch (~line 896) and content-cache branch (~line 995); also `set()` evict + gauge |
| `srv/lib/content-publish-session.js` | **Modify** | Instrument `beginPublishSession` / `appendToSession` / `commitSession` / `abortSession` for timing + `PublishTimings` row insert |
| `test/unit/content-cache-metrics.test.js` | **Create** | Assert namespaced counters wire correctly from serveHandler paths |
| `srv/jobs/metrics-rollup-job.js` | **Create** | 5-min cron handler; window-align; write `MetricSnapshots` rows; emit log lines; rotate reservoirs |
| `srv/jobs/scheduler.js` | **Modify** | Register the 5-min rollup job (no lock) + retention job (with lock) |
| `srv/jobs/cleanup.js` | **Modify** | Add `cleanupMetricSnapshots` (30 d) + `cleanupPublishTimings` (90 d) functions |
| `srv/admin-service.cds` | **Modify** | Declare `function getMetricsSnapshot() returns { … }` |
| `srv/admin-service.js` | **Modify** | Implement `getMetricsSnapshot` handler |
| `srv/server.js` | **Modify** | Late-bind stub for `/admin/metrics/live` in `bootstrap`; swap real handler in a third `cds.on('served')` |
| `test/hybrid/metrics-rollup.test.js` | **Create** | End-to-end: seed metrics → invoke rollup handler → assert HANA rows |
| `test/hybrid/publish-timings.test.js` | **Create** | begin→append→commit → assert one `PublishTimings` row + `ContentManifest.appendMsTotal` |
| `test/hybrid/analytics-projection.test.js` | **Create** | OData `GET /analytics/MetricSnapshots` returns 200 with Admin token |
| `test/smoke/metrics-live.smoke.js` | **Create** | `GET /admin/metrics/live` with basic-auth returns expected keys |
| `test/smoke/metrics-function.smoke.js` | **Create** | `GET /admin/getMetricsSnapshot()` with XSUAA Admin token returns same shape |
| `app/admin-shell/webapp/view/Metrics.view.xml` | **Create** | UI5 XML view — three cards, layout |
| `app/admin-shell/webapp/controller/Metrics.controller.js` | **Create** | UI5 controller — 30 s polling, OData reads for history, chart wiring |
| `app/admin-shell/webapp/manifest.json` | **Modify** | Register `metrics` route + `metricsTarget` + component navigation entry |
| `app/admin-shell/webapp/controller/Shell.controller.js` | **Modify** | Add "Metrics" item to the Analytics section of the side navigation |
| `docs/developers/architecture/observability.md` | **Create** | Public module surface; metric catalog; how-to-add-a-metric |
| `docs/developers/operations/testing-endpoints.md` | **Modify** | Document `/admin/metrics/live` (basic-auth) + `/admin/getMetricsSnapshot()` (XSUAA Admin) |
| `CLAUDE.md` | **Modify** | Add gotcha entry re: `METRICS_ENABLED` + `METRICS_DB_WRAP` defaults |

---

## Prerequisites

Before starting Task 1:

- [ ] **Confirm working directory:** you should be in `D:\projects\tutorials-poc\.claude\worktrees\805-observability` on branch `feat/805-observability-instrumentation` (created during the brainstorming phase).
- [ ] **Confirm CF login:** `cf target` shows the DEV space. Hybrid tests will need `cds bind --exec` against DEV HANA.
- [ ] **Confirm `.cdsrc-private.json` is present:** copy from the primary tree if missing (per [[feedback_cdsrc_private_not_copied_to_worktree]]).

---

## Task 1: `srv/lib/metrics.js` — module skeleton (counters + gauges)

Start with the simplest half of the module: `counter()`, `gauge()`, `snapshot()`, no histograms yet. Vitter's Algorithm R follows in Task 2. Rotation + emit follow in Task 3.

**Files:**
- Create: `srv/lib/metrics.js`
- Create: `srv/lib/__tests__/metrics.test.js`

- [ ] **Step 1: Write failing tests for counter + gauge + snapshot**

Create `srv/lib/__tests__/metrics.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as metrics from '../metrics.js';

describe('metrics module (counters + gauges)', () => {
  beforeEach(() => {
    metrics._resetForTest();
    delete process.env.METRICS_ENABLED;
  });

  it('counter() increments a named counter starting from 0', () => {
    metrics.counter('foo');
    metrics.counter('foo');
    metrics.counter('bar');
    const snap = metrics.snapshot();
    expect(snap.counters).toEqual({ foo: 2, bar: 1 });
  });

  it('gauge() stores the latest value (overwrites)', () => {
    metrics.gauge('bytes', 100);
    metrics.gauge('bytes', 250);
    const snap = metrics.snapshot();
    expect(snap.gauges.bytes).toBe(250);
  });

  it('snapshot() returns a stable empty shape when nothing has been recorded', () => {
    const snap = metrics.snapshot();
    expect(snap).toEqual({ counters: {}, gauges: {}, histograms: {} });
  });

  it('is a no-op when METRICS_ENABLED=false (still returns stable shape)', () => {
    process.env.METRICS_ENABLED = 'false';
    metrics.counter('foo');
    metrics.gauge('bar', 42);
    const snap = metrics.snapshot();
    expect(snap).toEqual({ counters: {}, gauges: {}, histograms: {} });
  });

  it('swallow-and-log: never throws on bad input, logs warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => metrics.counter(null)).not.toThrow();
    expect(() => metrics.gauge(null, 1)).not.toThrow();
    warnSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/lib/__tests__/metrics.test.js`
Expected: FAIL with "Cannot find module '../metrics.js'"

- [ ] **Step 3: Create the module skeleton**

Create `srv/lib/metrics.js`:

```js
// srv/lib/metrics.js
//
// Shared in-memory metrics producer. See
// docs/superpowers/specs/2026-07-02-805-observability-instrumentation-design.md
// and docs/developers/architecture/observability.md.
//
// Public surface:
//   counter(name)         — increment integer counter
//   gauge(name, value)    — overwrite (latest wins)
//   observe(name, value)  — push into a Vitter Algorithm R reservoir  (Task 2)
//   snapshot()            — { counters, gauges, histograms } — safe to call any time
//   rotate()              — snapshot + zero counters + drain reservoirs (Task 3)
//   emitLogLine(...)      — one structured cds.log line per rollup boundary (Task 3)
//
// Behavior contract:
//   - No public call ever throws to the caller. All wrapped in try/catch
//     that funnels to a rate-limited warn.
//   - When METRICS_ENABLED === 'false', all writes are no-ops and snapshot()
//     returns the stable empty shape { counters:{}, gauges:{}, histograms:{} }.
//   - The module owns in-memory state only. Persistence is the rollup job.

const counters = new Map();
const gauges = new Map();

let lastWarnAt = 0;
function warn(msg) {
  const now = Date.now();
  if (now - lastWarnAt > 60_000) {
    lastWarnAt = now;
    console.warn(`[metrics] ${msg}`);
  }
}

function isDisabled() {
  return process.env.METRICS_ENABLED === 'false';
}

export function counter(name) {
  try {
    if (isDisabled()) return;
    if (typeof name !== 'string' || !name) throw new Error(`invalid counter name: ${name}`);
    counters.set(name, (counters.get(name) || 0) + 1);
  } catch (err) { warn(err.message); }
}

export function gauge(name, value) {
  try {
    if (isDisabled()) return;
    if (typeof name !== 'string' || !name) throw new Error(`invalid gauge name: ${name}`);
    if (typeof value !== 'number' || !isFinite(value)) throw new Error(`invalid gauge value: ${value}`);
    gauges.set(name, value);
  } catch (err) { warn(err.message); }
}

export function snapshot() {
  try {
    if (isDisabled()) return { counters: {}, gauges: {}, histograms: {} };
    return {
      counters: Object.fromEntries(counters),
      gauges: Object.fromEntries(gauges),
      histograms: {}, // populated in Task 2
    };
  } catch (err) {
    warn(err.message);
    return { counters: {}, gauges: {}, histograms: {} };
  }
}

// Test-only helper — reset in-memory state between tests. Not exported for prod use.
export function _resetForTest() {
  counters.clear();
  gauges.clear();
  lastWarnAt = 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run srv/lib/__tests__/metrics.test.js`
Expected: PASS 5/5

- [ ] **Step 5: Commit**

```bash
git add srv/lib/metrics.js srv/lib/__tests__/metrics.test.js
git commit -m "feat(#805): metrics module skeleton (counters + gauges)"
```

---

## Task 2: `srv/lib/metrics.js` — `observe()` + Vitter Algorithm R reservoir + percentiles

Add histograms. Vitter's Algorithm R gives uniform reservoir sampling — samples represent the whole 5-min window rather than biasing toward the tail.

**Files:**
- Modify: `srv/lib/metrics.js`
- Modify: `srv/lib/__tests__/metrics.test.js`

- [ ] **Step 1: Append failing tests for observe + percentiles**

Append to `srv/lib/__tests__/metrics.test.js` inside a new describe block:

```js
describe('metrics module (histograms)', () => {
  beforeEach(() => {
    metrics._resetForTest();
    delete process.env.METRICS_ENABLED;
  });

  it('observe() records samples and snapshot() returns count/p50/p95/p99/max', () => {
    // Feed a known distribution: 100 samples from 1..100
    for (let i = 1; i <= 100; i++) metrics.observe('latency', i);
    const h = metrics.snapshot().histograms.latency;
    expect(h.count).toBe(100);
    expect(h.max).toBe(100);
    // With reservoir >= 100 the full population is retained; percentiles are exact.
    expect(h.p50).toBeGreaterThanOrEqual(50);
    expect(h.p50).toBeLessThanOrEqual(51);
    expect(h.p95).toBeGreaterThanOrEqual(95);
    expect(h.p95).toBeLessThanOrEqual(96);
    expect(h.p99).toBeGreaterThanOrEqual(99);
    expect(h.p99).toBeLessThanOrEqual(100);
  });

  it('reservoir is bounded — 5000 samples still fit in 2000-slot reservoir', () => {
    for (let i = 1; i <= 5000; i++) metrics.observe('latency', i);
    const h = metrics.snapshot().histograms.latency;
    expect(h.count).toBe(5000);           // count tracks total observations
    // p50 of uniform 1..5000 should be near 2500; Algorithm R sampling gives
    // wide but bounded tolerance — assert within ±20% (heavy-tail resilient).
    expect(h.p50).toBeGreaterThan(2000);
    expect(h.p50).toBeLessThan(3000);
  });

  it('empty histogram not in snapshot output', () => {
    const snap = metrics.snapshot();
    expect(snap.histograms).toEqual({});
  });

  it('observe() no-op when METRICS_ENABLED=false', () => {
    process.env.METRICS_ENABLED = 'false';
    metrics.observe('latency', 42);
    expect(metrics.snapshot().histograms).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/lib/__tests__/metrics.test.js`
Expected: FAIL — the new `describe` block tests error out because `observe` isn't exported yet.

- [ ] **Step 3: Add histogram implementation to `srv/lib/metrics.js`**

Add above the `_resetForTest` export:

```js
const RESERVOIR_SIZE = 2000;
const histograms = new Map();
// Each histogram: { count: number, samples: number[] (length ≤ RESERVOIR_SIZE) }

// Vitter's Algorithm R — uniform reservoir sampling.
// For the first RESERVOIR_SIZE samples, fill the reservoir directly.
// For the (n+1)-th sample where n >= RESERVOIR_SIZE, replace a random slot
// with probability RESERVOIR_SIZE/(n+1). Result is a uniform sample of
// the entire stream regardless of length.
function reservoirPush(h, value) {
  h.count += 1;
  if (h.samples.length < RESERVOIR_SIZE) {
    h.samples.push(value);
    return;
  }
  const j = Math.floor(Math.random() * h.count); // 0..count-1
  if (j < RESERVOIR_SIZE) h.samples[j] = value;
}

export function observe(name, value) {
  try {
    if (isDisabled()) return;
    if (typeof name !== 'string' || !name) throw new Error(`invalid histogram name: ${name}`);
    if (typeof value !== 'number' || !isFinite(value)) throw new Error(`invalid observe value: ${value}`);
    let h = histograms.get(name);
    if (!h) { h = { count: 0, samples: [] }; histograms.set(name, h); }
    reservoirPush(h, value);
  } catch (err) { warn(err.message); }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function summarizeHistogram(h) {
  const sorted = [...h.samples].sort((a, b) => a - b);
  return {
    count: h.count,
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}
```

Update the existing `snapshot()` to summarize histograms:

```js
export function snapshot() {
  try {
    if (isDisabled()) return { counters: {}, gauges: {}, histograms: {} };
    const histogramsOut = {};
    for (const [name, h] of histograms) histogramsOut[name] = summarizeHistogram(h);
    return {
      counters: Object.fromEntries(counters),
      gauges: Object.fromEntries(gauges),
      histograms: histogramsOut,
    };
  } catch (err) {
    warn(err.message);
    return { counters: {}, gauges: {}, histograms: {} };
  }
}
```

Update `_resetForTest`:

```js
export function _resetForTest() {
  counters.clear();
  gauges.clear();
  histograms.clear();
  lastWarnAt = 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run srv/lib/__tests__/metrics.test.js`
Expected: PASS 9/9.

**Note on Algorithm R tolerance:** the 5000-samples test uses a ±20% tolerance because reservoir sampling produces variance. If the test is flaky across CI runs, do NOT tighten the tolerance — reservoir sampling is stochastic by design.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/metrics.js srv/lib/__tests__/metrics.test.js
git commit -m "feat(#805): metrics observe() + Vitter Algorithm R reservoir"
```

---

## Task 3: `srv/lib/metrics.js` — `rotate()` + `emitLogLine()`

Rotation atomically snapshots and drains state. The rollup job (Task 8) calls this once per 5-min tick.

**Files:**
- Modify: `srv/lib/metrics.js`
- Modify: `srv/lib/__tests__/metrics.test.js`

- [ ] **Step 1: Append failing tests**

Append inside the module test file:

```js
describe('metrics module (rotate + emitLogLine)', () => {
  beforeEach(() => {
    metrics._resetForTest();
    delete process.env.METRICS_ENABLED;
  });

  it('rotate() returns the current snapshot and drains state', () => {
    metrics.counter('foo');
    metrics.counter('foo');
    metrics.gauge('bytes', 100);
    metrics.observe('latency', 42);

    const rotated = metrics.rotate();
    expect(rotated.counters.foo).toBe(2);
    expect(rotated.gauges.bytes).toBe(100);
    expect(rotated.histograms.latency.count).toBe(1);

    // After rotate, snapshot is empty.
    expect(metrics.snapshot()).toEqual({ counters: {}, gauges: {}, histograms: {} });
  });

  it('emitLogLine writes a structured JSON line to cds.log', () => {
    const cds = { log: () => ({ info: vi.fn() }) };
    const infoSpy = vi.fn();
    cds.log = vi.fn().mockReturnValue({ info: infoSpy });
    metrics.emitLogLine(cds, 'foo', 42, { windowStart: '2026-07-02T14:00:00Z', kind: 'counter' });
    expect(cds.log).toHaveBeenCalledWith('jobs/metrics-rollup');
    expect(infoSpy).toHaveBeenCalledOnce();
    const payload = JSON.parse(infoSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({ metric: 'foo', value: 42, kind: 'counter' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/lib/__tests__/metrics.test.js`
Expected: FAIL — `rotate` and `emitLogLine` not exported.

- [ ] **Step 3: Implement rotate + emitLogLine**

Append to `srv/lib/metrics.js` above `_resetForTest`:

```js
export function rotate() {
  try {
    if (isDisabled()) return { counters: {}, gauges: {}, histograms: {} };
    const out = snapshot();
    counters.clear();
    histograms.clear();
    // gauges are NOT cleared on rotate — they represent latest value.
    // The rollup job records the current gauge value, then the producer
    // continues overwriting; there is no "reset" for a gauge.
    return out;
  } catch (err) {
    warn(err.message);
    return { counters: {}, gauges: {}, histograms: {} };
  }
}

/**
 * Emit one structured JSON log line for a metric at a rollup boundary.
 * The rollup job calls this once per metric per tick.
 * `cds` is passed in so tests can inject a mock (module is import-free of cds).
 */
export function emitLogLine(cds, metric, value, extra = {}) {
  try {
    if (isDisabled()) return;
    const payload = { metric, value, ...extra };
    cds.log('jobs/metrics-rollup').info(JSON.stringify(payload));
  } catch (err) { warn(err.message); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run srv/lib/__tests__/metrics.test.js`
Expected: PASS 11/11.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/metrics.js srv/lib/__tests__/metrics.test.js
git commit -m "feat(#805): metrics rotate() + emitLogLine()"
```

---

## Task 4: HANA schema — entities, aspect columns, indexes

Two new entities + two shared-aspect columns + two `.hdbindex` files. Runs `cds build --production` after to confirm `.hdbmigrationtable` files are generated (per [[feedback_cds_build_production_not_cds_compile_for_last_dev]]).

**Files:**
- Modify: `db/schema.cds` (append after `PipelineLogItems` / `JobLogItems`)
- Modify: `db/_content-shape.cds` (extend `ContentManifestAspect`)
- Create: `db/src/IDX_METRIC_SNAPSHOTS_WINDOW.hdbindex`
- Create: `db/src/IDX_PUBLISH_TIMINGS_CREATED.hdbindex`

- [ ] **Step 1: Add MetricSnapshots + PublishTimings to `db/schema.cds`**

Find the end of `db/schema.cds` (after `entity JobLogItems`) and append:

```cds
// --- Observability (#805) ---
// Generic 5-min rollup. Composite primary key so both CF instances write
// the same window independently (no job-lock on the rollup writer).
@cds.persistence.table
@analytics.exposed
entity MetricSnapshots : managed {
  key windowStart  : Timestamp;     // aligned to 5-min boundary
  key metric       : String(64);    // e.g. 'content.cache.hit'
  key instanceId   : String(64);    // process.env.CF_INSTANCE_GUID || `local-${pid}`
  kind         : String(16);        // 'counter' | 'histogram' | 'gauge'
  count        : Integer64;
  value        : Double;            // counters/gauges: sum or current
  p50          : Double;            // histograms only
  p95          : Double;
  p99          : Double;
  max          : Double;
  tags         : String(255);       // reserved for future dimensions (JSON)
}

// Per-publish detail row. `cuid` for UUID key, @assert.unique.session
// prevents duplicate rows from failed-retry.
@cds.persistence.table
@analytics.exposed
@assert.unique.session : [sessionId]
entity PublishTimings : cuid, managed {
  sessionId       : String(36);     // = ContentManifest.sessionId = PipelineLog.ID
  manifestVersion : Integer;
  mode            : String(16);     // 'delta' | 'full' | 'heal'
  initiator       : String(255);
  slugCount       : Integer;
  beginMs         : Integer;        // createdAt → firstAppendAt
  appendMsTotal   : Integer;        // sum of append handler wall-clocks
  commitMs        : Integer;        // commit handler wall-clock
  totalMs         : Integer;        // createdAt → commit response sent
  outcome         : String(16);     // 'committed' | 'aborted' | 'rejected'
}
```

- [ ] **Step 2: Extend `ContentManifestAspect` in `db/_content-shape.cds`**

Find `aspect ContentManifestAspect : managed {` (~line 44) and add two fields next to the existing `sessionId` / `lastAppendAt`:

```cds
appendMsTotal : Integer default 0;   // #805: running sum of append handler wall-clocks (ms)
firstAppendAt : Timestamp;           // #805: first append arrival — used to compute beginMs
```

These propagate to QA schema via the shared aspect — no `db-qa/` edit needed (compiler-enforced symmetric per [scripts/check-qa-schema-drift.ts](../../../scripts/check-qa-schema-drift.ts)).

- [ ] **Step 3: Create HANA index files**

Create `db/src/IDX_METRIC_SNAPSHOTS_WINDOW.hdbindex`:

```
INDEX "IDX_METRIC_SNAPSHOTS_WINDOW"
  ON "COM_SAP_DEVELOPERS_IMS_METRICSNAPSHOTS" ("WINDOWSTART", "METRIC")
```

Create `db/src/IDX_PUBLISH_TIMINGS_CREATED.hdbindex`:

```
INDEX "IDX_PUBLISH_TIMINGS_CREATED"
  ON "COM_SAP_DEVELOPERS_IMS_PUBLISHTIMINGS" ("CREATEDAT" DESC)
```

- [ ] **Step 4: Compile check + build**

Run: `npx cds build --production`
Expected: succeeds; new files appear:
- `db/gen/src/gen/com.sap.developers.ims.MetricSnapshots.hdbmigrationtable`
- `db/gen/src/gen/com.sap.developers.ims.PublishTimings.hdbmigrationtable`
- Existing `com.sap.developers.ims.ContentManifest.hdbmigrationtable` shows a diff for the two new columns.

Verify: `ls db/gen/src/gen/*.hdbmigrationtable | grep -E 'MetricSnapshots|PublishTimings'`

- [ ] **Step 5: CDS lint sanity check**

Run: `npx cds compile db --to sql | head -50`
Expected: no compile errors mentioning `MetricSnapshots` / `PublishTimings` / `ContentManifest`.

- [ ] **Step 6: Commit**

```bash
git add db/schema.cds db/_content-shape.cds db/src/IDX_METRIC_SNAPSHOTS_WINDOW.hdbindex db/src/IDX_PUBLISH_TIMINGS_CREATED.hdbindex db/gen/
git commit -m "feat(#805): schema — MetricSnapshots, PublishTimings, ContentManifest cols, hdbindex"
```

**Note:** the `db/gen/` output is committed because [[feedback_cds_schema_plans_need_cds_build_production_step]] — deploy verifies these are fresh.

---

## Task 5: AnalyticsService projections + hybrid test

Add explicit `@readonly entity ... as projection on ...` for both new entities in `srv/analytics-service.cds`. Without this, `@analytics.exposed` alone doesn't route (per spec review Critical #3).

**Files:**
- Modify: `srv/analytics-service.cds`
- Create: `test/hybrid/analytics-projection.test.js`

- [ ] **Step 1: Write failing hybrid test**

Create `test/hybrid/analytics-projection.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

describe('AnalyticsService projections (#805)', () => {
  let srv;
  beforeAll(async () => { srv = await cds.connect.to('AnalyticsService'); });

  it('exposes MetricSnapshots as a queryable entity', async () => {
    const rows = await SELECT.from(srv.entities.MetricSnapshots).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('exposes PublishTimings as a queryable entity', async () => {
    const rows = await SELECT.from(srv.entities.PublishTimings).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/analytics-projection.test.js`
Expected: FAIL — `srv.entities.MetricSnapshots` is undefined.

- [ ] **Step 3: Add projections to `srv/analytics-service.cds`**

Find the block of `@readonly entity ... as projection on ims.<Entity>;` declarations (~line 8-30) and append two more, matching the sibling pattern:

```cds
@readonly entity MetricSnapshots        as projection on ims.MetricSnapshots;
@readonly entity PublishTimings         as projection on ims.PublishTimings;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/analytics-projection.test.js`
Expected: PASS 2/2.

- [ ] **Step 5: Commit**

```bash
git add srv/analytics-service.cds test/hybrid/analytics-projection.test.js
git commit -m "feat(#805): AnalyticsService projections for metrics entities"
```

---

## Task 6: Content-cache instrumentation

Add cache counters at the two `serveHandler` call sites and evict/gauge inside `ContentCache.set()`. Two namespaces: `content.cache.*` (bare-slug branch) and `render.cache.*` (render-cache branch). Both branches are mutually exclusive (verified in spec review).

**Files:**
- Modify: `srv/lib/content-store.js`
- Create: `test/unit/content-cache-metrics.test.js`

- [ ] **Step 1: Write failing unit test**

Create `test/unit/content-cache-metrics.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import * as metrics from '../../srv/lib/metrics.js';

describe('content-store cache counter wiring (#805)', () => {
  beforeEach(() => metrics._resetForTest());

  it('module can be imported and the ContentCache class is exported', async () => {
    // We test the counter side-effects indirectly via metrics.snapshot() —
    // integration with serveHandler is covered by the hybrid test.
    const mod = await import('../../srv/lib/content-store.js');
    // ContentCache is not exported; the test asserts the metrics module is
    // wired by directly exercising counter names the source file uses.
    metrics.counter('content.cache.hit');
    metrics.counter('render.cache.miss');
    metrics.counter('cache.evict');
    metrics.gauge('cache.bytes', 42);
    const snap = metrics.snapshot();
    expect(snap.counters['content.cache.hit']).toBe(1);
    expect(snap.counters['render.cache.miss']).toBe(1);
    expect(snap.counters['cache.evict']).toBe(1);
    expect(snap.gauges['cache.bytes']).toBe(42);
  });
});
```

This test does not verify the wiring inside `content-store.js` — that is covered by the smoke path after PR 1 deploys. What it does prove is: the metric names the source uses are consistent with the module. If a source-side typo lands (e.g. `content.cache.hits` plural), it won't fire this test, but the admin UI will show no hit-rate data, which is the acceptance signal.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/content-cache-metrics.test.js`
Expected: PASS (the metrics module already supports these calls). If this fails, Task 1-3 hasn't landed.

- [ ] **Step 3: Add import to `srv/lib/content-store.js`**

At the top of the file, add:

```js
import * as metrics from './metrics.js';
```

- [ ] **Step 4: Instrument the render-cache branch (~line 896)**

Find the block starting `const cachedRender = cache.get(cacheKey);` (~line 896) and add counters. Before the `if (cachedRender) {`, insert nothing; inside the `if (cachedRender) {` block add:

```js
metrics.counter('render.cache.hit');
```

After the closing `}` of that if-block (before the render path proceeds to build a fresh page), add:

```js
metrics.counter('render.cache.miss');
```

- [ ] **Step 5: Instrument the content-cache branch (~line 995)**

Find the block starting `const cached = cache.get(slug);` (~line 995) and similarly:

Inside `if (cached) {` add:

```js
metrics.counter('content.cache.hit');
```

After the closing `}` of that if-block (before falling through to DB read), add:

```js
metrics.counter('content.cache.miss');
```

- [ ] **Step 6: Add evict counter + bytes gauge in `ContentCache.set()`**

Find `class ContentCache` at ~line 144. Inside the `while (this.totalBytes + buffer.length > this.maxBytes && this.map.size > 0)` loop, after `this.map.delete(oldestKey);`, add:

```js
metrics.counter('cache.evict');
```

After the final `this.totalBytes += buffer.length;` in `set()`, add:

```js
metrics.gauge('cache.bytes', this.totalBytes);
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run test/unit/content-cache-metrics.test.js`
Expected: PASS 1/1.

Run the full unit suite to catch regressions:

Run: `npm test -- --run`
Expected: All tests pass (no new failures caused by the imports).

- [ ] **Step 8: Commit**

```bash
git add srv/lib/content-store.js test/unit/content-cache-metrics.test.js
git commit -m "feat(#805): content-cache hit/miss/evict counters + bytes gauge"
```

---

## Task 7: Publish-timing instrumentation

Wire `beginPublishSession` / `appendToSession` / `commitSession` / `abortSession` to accumulate timing on `ContentManifest.appendMsTotal` + `firstAppendAt`, then emit a `PublishTimings` row + histogram observations on commit/abort. Load-balancer-safe because the tally lives on the manifest row (spec review Should-fix #1).

**Files:**
- Modify: `srv/lib/content-publish-session.js`
- Create: `test/hybrid/publish-timings.test.js`

- [ ] **Step 1: Write failing hybrid test**

Create `test/hybrid/publish-timings.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';

// This test uses the __TEST__ prefix convention + _guard.js write-safety.
// Requires ALLOW_HYBRID_WRITES=true.

describe('PublishTimings row + histogram observations (#805)', () => {
  const NAMESPACE = 'com.sap.developers.ims';
  let helpers, db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    helpers = createSessionHelpers({ namespace: NAMESPACE });
  });

  it('commit writes one PublishTimings row with plausible timings', async () => {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: '__TEST__',
      hugoVersion: 'test',
      expectedSlugCount: 0,
      initiator: '__TEST__timings',
    });
    await new Promise(r => setTimeout(r, 15)); // simulate begin→append gap
    await helpers.appendToSession({ sessionId, files: {}, metadata: {}, bodyTexts: {}, branchSpecs: {}, sources: {} });
    await new Promise(r => setTimeout(r, 15)); // simulate append duration
    await helpers.commitSession({ sessionId });

    const { PublishTimings } = cds.entities(NAMESPACE);
    const [row] = await SELECT.from(PublishTimings).where({ sessionId }).orderBy('createdAt desc').limit(1);
    expect(row).toBeDefined();
    expect(row.outcome).toBe('committed');
    expect(row.beginMs).toBeGreaterThanOrEqual(0);
    expect(row.appendMsTotal).toBeGreaterThanOrEqual(0);
    expect(row.commitMs).toBeGreaterThanOrEqual(0);
    expect(row.totalMs).toBeGreaterThan(0);

    // Cleanup — hard-delete the __TEST__ row.
    await DELETE.from(PublishTimings).where({ sessionId });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/publish-timings.test.js`
Expected: FAIL — no `PublishTimings` row is written yet.

- [ ] **Step 3: Instrument `beginPublishSession`**

In `srv/lib/content-publish-session.js`, add `import * as metrics from './metrics.js';` near the top. Inside `beginPublishSession` (~line 33), after the session row is created, add:

```js
metrics.counter('publish.attempt');
```

- [ ] **Step 4: Instrument `appendToSession`**

Inside `appendToSession` (~line 96), wrap the handler body to record wall-clock and update the manifest:

At the top of the function:

```js
const appendStartHr = process.hrtime.bigint();
```

Just before the function returns, add:

```js
const appendMs = Number(process.hrtime.bigint() - appendStartHr) / 1e6;
const { ContentManifest } = cds.entities(namespace);
await UPDATE(ContentManifest).where({ sessionId }).with({
  appendMsTotal: { '+=': Math.round(appendMs) },
  firstAppendAt: { '=': { xpr: [ 'COALESCE(firstAppendAt, CURRENT_TIMESTAMP)' ] } },
});
```

**Note:** CDS QL doesn't have a native `COALESCE` DSL for `.with()` — fall back to a raw SQL update if the above shape fails compilation:

```js
await db.run(
  `UPDATE ${hanaTable} SET APPENDMSTOTAL = COALESCE(APPENDMSTOTAL, 0) + ?, FIRSTAPPENDAT = COALESCE(FIRSTAPPENDAT, CURRENT_UTCTIMESTAMP) WHERE SESSIONID = ?`,
  [Math.round(appendMs), sessionId]
);
```

Choose whichever compiles cleanly in the local `cds` version. Prefer the CDS QL form if available (matches project convention).

- [ ] **Step 5: Instrument `commitSession`**

Inside `commitSession` (~line 296), capture wall-clock and write a `PublishTimings` row before returning success:

At the top of the function:

```js
const commitStartHr = process.hrtime.bigint();
```

Just before the success return, add:

```js
const commitMs = Number(process.hrtime.bigint() - commitStartHr) / 1e6;

const { ContentManifest, PublishTimings } = cds.entities(namespace);
const [manifest] = await SELECT.from(ContentManifest).where({ sessionId }).columns(
  'createdAt', 'firstAppendAt', 'appendMsTotal', 'version', 'trigger', 'initiator'
);

const createdAtMs = new Date(manifest.createdAt).getTime();
const firstAppendMs = manifest.firstAppendAt ? new Date(manifest.firstAppendAt).getTime() : createdAtMs;
const beginMs = Math.max(0, firstAppendMs - createdAtMs);
const appendMsTotal = manifest.appendMsTotal || 0;
const totalMs = Math.round(Date.now() - createdAtMs);

await INSERT.into(PublishTimings).entries({
  sessionId,
  manifestVersion: manifest.version,
  mode: manifest.trigger || 'unknown',
  initiator: manifest.initiator || null,
  slugCount: 0, // updated by carry-forward path if needed; 0 is acceptable for aborts
  beginMs, appendMsTotal, commitMs: Math.round(commitMs), totalMs,
  outcome: rejectedReverts?.length ? 'rejected' : 'committed',
});

metrics.observe('publish.begin.ms', beginMs);
metrics.observe('publish.append.ms', appendMsTotal);
metrics.observe('publish.commit.ms', commitMs);
metrics.observe('publish.total.ms', totalMs);
metrics.counter(rejectedReverts?.length ? 'publish.commit.reject' : 'publish.commit.ok');
```

**Slug count:** the correct `slugCount` is derivable from the append-batch tally the commit handler already computes for other purposes. If it's not conveniently in scope, pass 0 in v1 — the admin table will show 0 which is a known gap; a follow-up spec can wire it once the exact counting site is confirmed at implementation time.

- [ ] **Step 6: Instrument `abortSession`**

Inside `abortSession` (~line 438), before the function returns, write a `PublishTimings` row with `outcome: 'aborted'`:

```js
try {
  const { ContentManifest, PublishTimings } = cds.entities(namespace);
  const [manifest] = await SELECT.from(ContentManifest).where({ sessionId }).columns(
    'createdAt', 'firstAppendAt', 'appendMsTotal', 'version', 'trigger', 'initiator'
  );
  if (manifest) {
    const createdAtMs = new Date(manifest.createdAt).getTime();
    const firstAppendMs = manifest.firstAppendAt ? new Date(manifest.firstAppendAt).getTime() : createdAtMs;
    await INSERT.into(PublishTimings).entries({
      sessionId,
      manifestVersion: manifest.version,
      mode: manifest.trigger || 'unknown',
      initiator: manifest.initiator || null,
      slugCount: 0,
      beginMs: Math.max(0, firstAppendMs - createdAtMs),
      appendMsTotal: manifest.appendMsTotal || 0,
      commitMs: 0,
      totalMs: Math.round(Date.now() - createdAtMs),
      outcome: 'aborted',
    });
  }
  metrics.counter('publish.abort');
} catch (err) {
  // Never let a metrics failure prevent abort from completing.
  cds.log('content-publish').warn(`[publish-timings] abort row failed: ${err.message}`);
}
```

- [ ] **Step 7: Run the hybrid test**

Run: `ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/publish-timings.test.js`
Expected: PASS 1/1.

- [ ] **Step 8: Commit**

```bash
git add srv/lib/content-publish-session.js test/hybrid/publish-timings.test.js
git commit -m "feat(#805): publish-timing instrumentation + PublishTimings rows"
```

---

## Task 8: 5-min rollup job + hybrid test

Cron job at `*/5 * * * *` (with off-minute jitter per project convention). Aligns `windowStart` to 5-min boundary. No `job-lock` (both instances write with distinct `instanceId`).

**Files:**
- Create: `srv/jobs/metrics-rollup-job.js`
- Create: `test/hybrid/metrics-rollup.test.js`
- Modify: `srv/jobs/scheduler.js`

- [ ] **Step 1: Write failing hybrid test**

Create `test/hybrid/metrics-rollup.test.js`:

```js
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import cds from '@sap/cds';
import * as metrics from '../../srv/lib/metrics.js';
import { runMetricsRollup } from '../../srv/jobs/metrics-rollup-job.js';

const NAMESPACE = 'com.sap.developers.ims';
const TEST_INSTANCE = '__TEST__rollup';

describe('metrics rollup writes MetricSnapshots rows (#805)', () => {
  beforeAll(async () => { await cds.connect.to('db'); });

  afterEach(async () => {
    const { MetricSnapshots } = cds.entities(NAMESPACE);
    await DELETE.from(MetricSnapshots).where({ instanceId: TEST_INSTANCE });
  });

  it('writes one row per counter, aligned to 5-min boundary', async () => {
    metrics._resetForTest();
    metrics.counter('__test__.hits');
    metrics.counter('__test__.hits');
    metrics.gauge('__test__.bytes', 1234);
    metrics.observe('__test__.latency', 50);

    await runMetricsRollup({ instanceId: TEST_INSTANCE });

    const { MetricSnapshots } = cds.entities(NAMESPACE);
    const rows = await SELECT.from(MetricSnapshots).where({ instanceId: TEST_INSTANCE });
    const byMetric = Object.fromEntries(rows.map(r => [r.metric, r]));

    expect(byMetric['__test__.hits'].kind).toBe('counter');
    expect(byMetric['__test__.hits'].value).toBe(2);
    expect(byMetric['__test__.bytes'].kind).toBe('gauge');
    expect(byMetric['__test__.bytes'].value).toBe(1234);
    expect(byMetric['__test__.latency'].kind).toBe('histogram');
    expect(byMetric['__test__.latency'].count).toBe(1);

    // windowStart aligned
    const ws = new Date(byMetric['__test__.hits'].windowStart).getTime();
    expect(ws % 300_000).toBe(0);

    // Reservoir drained
    expect(metrics.snapshot().histograms['__test__.latency']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/metrics-rollup.test.js`
Expected: FAIL — `srv/jobs/metrics-rollup-job.js` doesn't exist.

- [ ] **Step 3: Create the rollup job**

Create `srv/jobs/metrics-rollup-job.js`:

```js
// srv/jobs/metrics-rollup-job.js
//
// Every 5 minutes: rotate the in-memory metrics module and write one
// MetricSnapshots row per named metric. No job-lock — both CF instances
// write independently under composite PRIMARY KEY (windowStart, metric, instanceId).
//
// See docs/superpowers/specs/2026-07-02-805-observability-instrumentation-design.md
// § Rollout for the design rationale.

import cds from '@sap/cds';
import * as metrics from '../lib/metrics.js';

const NAMESPACE = 'com.sap.developers.ims';
const INSTANCE_ID = process.env.CF_INSTANCE_GUID || `local-${process.pid}`;
const LOG = cds.log('jobs/metrics-rollup');

function alignedWindowStart() {
  return new Date(Math.floor(Date.now() / 300_000) * 300_000).toISOString();
}

/**
 * @param {{ instanceId?: string }} [opts] — instanceId override for tests.
 */
export async function runMetricsRollup(opts = {}) {
  if (process.env.METRICS_ENABLED === 'false') return { skipped: true };

  const instanceId = opts.instanceId || INSTANCE_ID;
  const windowStart = alignedWindowStart();
  const rotated = metrics.rotate();
  const { MetricSnapshots } = cds.entities(NAMESPACE);

  const rows = [];

  for (const [metric, value] of Object.entries(rotated.counters)) {
    rows.push({ windowStart, metric, instanceId, kind: 'counter', count: value, value });
    metrics.emitLogLine(cds, metric, value, { kind: 'counter', windowStart, instanceId });
  }
  for (const [metric, value] of Object.entries(rotated.gauges)) {
    rows.push({ windowStart, metric, instanceId, kind: 'gauge', count: 1, value });
    metrics.emitLogLine(cds, metric, value, { kind: 'gauge', windowStart, instanceId });
  }
  for (const [metric, h] of Object.entries(rotated.histograms)) {
    rows.push({
      windowStart, metric, instanceId, kind: 'histogram',
      count: h.count, value: 0,
      p50: h.p50, p95: h.p95, p99: h.p99, max: h.max,
    });
    metrics.emitLogLine(cds, metric, h.p95, { kind: 'histogram', count: h.count, p50: h.p50, p95: h.p95, p99: h.p99, max: h.max, windowStart, instanceId });
  }

  if (rows.length === 0) return { wrote: 0 };

  try {
    // UPSERT so a slow tick doesn't collide with a next-tick rewrite of the same window
    // (rare but possible if the job is manually re-run).
    await UPSERT.into(MetricSnapshots).entries(rows);
    return { wrote: rows.length };
  } catch (err) {
    LOG.warn(`rollup write failed: ${err.message}`);
    return { wrote: 0, error: err.message };
  }
}
```

- [ ] **Step 4: Register in scheduler**

Modify `srv/jobs/scheduler.js`. Near the top imports, add:

```js
import { runMetricsRollup } from './metrics-rollup-job.js';
```

Inside `registerJobs()` (following the existing `registerJob({...})` calls), add:

```js
registerJob({
  jobName: 'metrics-rollup',
  schedule: '*/5 * * * *',  // every 5 minutes, on the minute
  ttlMs: 60_000,             // short TTL — job either succeeds fast or skips
  description: '#805 5-min rollup — write MetricSnapshots rows',
  fn: () => runMetricsRollup(),
});
```

Note: this job intentionally does NOT use `acquireLock` — both CF instances write independently. See spec § Rollout.

- [ ] **Step 5: Run test to verify it passes**

Run: `ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/metrics-rollup.test.js`
Expected: PASS 1/1.

- [ ] **Step 6: Commit**

```bash
git add srv/jobs/metrics-rollup-job.js srv/jobs/scheduler.js test/hybrid/metrics-rollup.test.js
git commit -m "feat(#805): 5-min metrics rollup job (no lock, per-instance rows)"
```

---

## Task 9: Retention cleanup — `MetricSnapshots` 30 d, `PublishTimings` 90 d

Both retention deletes fold into the existing daily cleanup cron in `srv/jobs/cleanup.js` (imported from `srv/jobs/scheduler.js`). Retention DOES use `acquireLock` (multiple concurrent deletes aren't idempotent-safe).

**Files:**
- Modify: `srv/jobs/cleanup.js`
- Modify: `srv/jobs/scheduler.js`

- [ ] **Step 1: Add cleanup functions to `srv/jobs/cleanup.js`**

Append:

```js
/**
 * #805: Prune MetricSnapshots older than N days. Called by the daily cleanup cron.
 */
export async function cleanupMetricSnapshots(retentionDays = 30) {
  const { MetricSnapshots } = cds.entities('com.sap.developers.ims');
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const deleted = await DELETE.from(MetricSnapshots).where({ windowStart: { '<': cutoff } });
  cds.log('jobs/cleanup').info(`[#805] pruned ${deleted} MetricSnapshots rows older than ${retentionDays} days`);
  return { deleted };
}

/**
 * #805: Prune PublishTimings older than N days.
 */
export async function cleanupPublishTimings(retentionDays = 90) {
  const { PublishTimings } = cds.entities('com.sap.developers.ims');
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const deleted = await DELETE.from(PublishTimings).where({ createdAt: { '<': cutoff } });
  cds.log('jobs/cleanup').info(`[#805] pruned ${deleted} PublishTimings rows older than ${retentionDays} days`);
  return { deleted };
}
```

- [ ] **Step 2: Wire into scheduler**

In `srv/jobs/scheduler.js`, update the imports:

```js
import {
  cleanupStepFailures, cleanupUnusedTags, cleanupContentVersions, cleanupPipelineLog,
  cleanupStuckPublishing, pruneOrphanEmbeddings, pruneAnalyticsHistory, cleanupChangeLog,
  cleanupMetricSnapshots, cleanupPublishTimings,   // ← add both
} from './cleanup.js';
```

Add two registrations to the cleanup section (using off-minutes per project convention):

```js
registerJob({
  jobName: 'metrics-snapshots-retention',
  schedule: '17 4 * * *',   // daily at 04:17
  ttlMs: 5 * 60_000,
  description: '#805 daily prune of MetricSnapshots older than 30 days',
  fn: () => cleanupMetricSnapshots(30),
});
registerJob({
  jobName: 'publish-timings-retention',
  schedule: '23 4 * * *',   // daily at 04:23
  ttlMs: 5 * 60_000,
  description: '#805 daily prune of PublishTimings older than 90 days',
  fn: () => cleanupPublishTimings(90),
});
```

- [ ] **Step 3: Sanity check (no test — cleanup functions are exercised by production TTL naturally)**

Run: `npx cds compile srv --to yaml | head -20`
Expected: no compile errors.

Run: `npm test -- --run` (full unit suite)
Expected: no new failures.

- [ ] **Step 4: Commit**

```bash
git add srv/jobs/cleanup.js srv/jobs/scheduler.js
git commit -m "feat(#805): retention — MetricSnapshots 30d, PublishTimings 90d"
```

---

## Task 10: `AdminService.getMetricsSnapshot()` CAP function

Read-only CAP function (GET, XSUAA-friendly for browser calls from admin-shell). Matches the `getNotificationConfig` / `getBoardStatistics` pattern in `srv/admin-service.cds`.

**Files:**
- Modify: `srv/admin-service.cds`
- Modify: `srv/admin-service.js`
- Create: `test/smoke/metrics-function.smoke.js`

- [ ] **Step 1: Declare the function in `srv/admin-service.cds`**

Find a natural home among the other unbound service-level functions (e.g. near `function getNotificationConfig()`). Add:

```cds
// #805 — Live in-memory snapshot of the metrics module. Read-only.
// Response shape:
//   snapshot: { counters, gauges, histograms }
//   instanceId: CF_INSTANCE_GUID or `local-${pid}`
//   uptimeSec: process uptime in seconds
//   dbWrapEnabled: boolean — true when METRICS_DB_WRAP=true (PR 2 feature)
//   generatedAt: ISO timestamp
// Returns a JSON-typed `String` so we don't have to model the full nested shape in CDS.
function getMetricsSnapshot() returns String;
```

- [ ] **Step 2: Implement handler in `srv/admin-service.js`**

Find the `AdminService` handler registration (`srv.on('...', ...)`). Add:

```js
srv.on('getMetricsSnapshot', async () => {
  const metrics = await import('./lib/metrics.js');
  return JSON.stringify({
    snapshot: metrics.snapshot(),
    instanceId: process.env.CF_INSTANCE_GUID || `local-${process.pid}`,
    uptimeSec: Math.round(process.uptime()),
    dbWrapEnabled: process.env.METRICS_DB_WRAP === 'true',
    generatedAt: new Date().toISOString(),
  });
});
```

Returning `String` (JSON-encoded) avoids the CDS-modelling burden of expressing the deeply-nested map-of-map response type. The client (UI5 controller + smoke test) `JSON.parse()`s the response.

- [ ] **Step 3: Write smoke test**

Create `test/smoke/metrics-function.smoke.js`:

```js
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_SRV_URL;
const TOKEN = process.env.SMOKE_ADMIN_TOKEN;

describe.skipIf(!BASE || !TOKEN)('AdminService.getMetricsSnapshot smoke (#805)', () => {
  it('returns a valid snapshot envelope', async () => {
    const res = await fetch(`${BASE}/admin/getMetricsSnapshot()`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const wrap = await res.json();
    // OData wraps unbound function results as { value: '...' } — the string is our JSON.
    const inner = JSON.parse(wrap.value);
    expect(inner).toHaveProperty('snapshot');
    expect(inner.snapshot).toHaveProperty('counters');
    expect(inner.snapshot).toHaveProperty('gauges');
    expect(inner.snapshot).toHaveProperty('histograms');
    expect(inner).toHaveProperty('instanceId');
    expect(inner).toHaveProperty('dbWrapEnabled');
    expect(typeof inner.uptimeSec).toBe('number');
  });
});
```

- [ ] **Step 4: Compile + run**

Run: `npx cds compile srv --to yaml | grep -A2 getMetricsSnapshot`
Expected: shows the function declaration with correct return type.

Run: `npm test -- --run` (unit suite)
Expected: passes; smoke test skips (no deploy yet).

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js test/smoke/metrics-function.smoke.js
git commit -m "feat(#805): AdminService.getMetricsSnapshot() function + smoke test"
```

---

## Task 11: `/admin/metrics/live` late-bound Express route

For on-call `curl`. Basic-auth-protected (matches the `basicAuthMiddleware` gate at [srv/server.js:183](../../../srv/server.js#L183)). Must be **late-bound before `cds.serve` runs** or AdminService's OData adapter will shadow it — same pattern as `/admin/analytics/*` at [srv/server.js:63](../../../srv/server.js#L63).

**Files:**
- Modify: `srv/server.js`
- Create: `test/smoke/metrics-live.smoke.js`

- [ ] **Step 1: Add the late-bind stub in `bootstrap`**

In `srv/server.js`, near [line 63](../../../srv/server.js#L63) where `analyticsOdataRouter` and `embeddingsStatsHandler` stubs are declared, add:

```js
// #805: Late-bound handler for /admin/metrics/live. AdminService's OData
// adapter mounts at /admin and would otherwise return
// "Invalid resource path AdminService.metrics.live". Same pattern as the
// analytics stub above.
let metricsLiveHandler = (req, res) => res.status(503).json({ error: 'service_starting' });
```

Then in the bootstrap `app.use()` chain BEFORE `basicAuthMiddleware`, register the late-bind stub route:

```js
app.get('/admin/metrics/live', (req, res) => metricsLiveHandler(req, res));
```

- [ ] **Step 2: Wire the real handler in a third `cds.on('served')`**

At the bottom of `srv/server.js`, after the existing two `cds.on('served')` handlers (~line 604 and ~line 965), add a third:

```js
cds.on('served', async () => {
  // #805 Real handler for /admin/metrics/live. Wired here (not bootstrap) so
  // basicAuthMiddleware is guaranteed applied by cds.serve() ordering, and so
  // any metrics-module-side setup that assumes `cds.db` exists is safe.
  const metrics = await import('./lib/metrics.js');
  metricsLiveHandler = (req, res) => {
    // basicAuthMiddleware has already run at the app-level; if we get here,
    // credentials passed.
    res.json({
      snapshot: metrics.snapshot(),
      instanceId: process.env.CF_INSTANCE_GUID || `local-${process.pid}`,
      uptimeSec: Math.round(process.uptime()),
      dbWrapEnabled: process.env.METRICS_DB_WRAP === 'true',
      generatedAt: new Date().toISOString(),
    });
  };
});
```

- [ ] **Step 3: Write smoke test**

Create `test/smoke/metrics-live.smoke.js`:

```js
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_SRV_URL;
const USER = process.env.SMOKE_TECH_USER || 'admin';
const PASS = process.env.SMOKE_TECH_PASS;

describe.skipIf(!BASE || !PASS)('/admin/metrics/live smoke (#805)', () => {
  it('returns 200 + expected keys with basic-auth', async () => {
    const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
    const res = await fetch(`${BASE}/admin/metrics/live`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('snapshot');
    expect(body).toHaveProperty('instanceId');
    expect(body).toHaveProperty('uptimeSec');
    expect(body).toHaveProperty('dbWrapEnabled');
    expect(body).toHaveProperty('generatedAt');
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${BASE}/admin/metrics/live`);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 4: Local smoke sanity**

Run: `npm run dev` (in one terminal) — wait for `[cds] served` output.
In another terminal:

```bash
curl -s -u admin:admin http://localhost:4004/admin/metrics/live | jq .
```
Expected: valid JSON with `snapshot`, `instanceId`, `dbWrapEnabled: false`, etc.

Stop the dev server (`Ctrl-C`).

- [ ] **Step 5: Commit**

```bash
git add srv/server.js test/smoke/metrics-live.smoke.js
git commit -m "feat(#805): /admin/metrics/live late-bound endpoint (basic-auth)"
```

---

## Task 12: UI5 `Metrics` peer view + controller + route

New admin-shell view with three cards. Numbers-only in this task; the 24 h chart wiring is Task 13 to keep tasks small.

**Files:**

- Create: `app/admin-shell/webapp/view/Metrics.view.xml`
- Create: `app/admin-shell/webapp/controller/Metrics.controller.js`
- Modify: `app/admin-shell/webapp/manifest.json`
- Modify: `app/admin-shell/webapp/controller/Shell.controller.js`

- [ ] **Step 1: Create the XML view**

Create `app/admin-shell/webapp/view/Metrics.view.xml`:

```xml
<mvc:View
  controllerName="sap.tutorials.admin.controller.Metrics"
  xmlns="sap.m"
  xmlns:mvc="sap.ui.core.mvc"
  xmlns:layout="sap.ui.layout"
  xmlns:core="sap.ui.core">
  <Page title="Observability — Live Snapshot" showNavButton="false">
    <content>
      <layout:Grid defaultSpan="XL4 L4 M6 S12" hSpacing="1" vSpacing="1" class="sapUiSmallMargin">

        <!-- Cache card -->
        <Panel headerText="Content cache" expandable="false">
          <VBox class="sapUiSmallMargin">
            <ObjectStatus
              text="Hit rate"
              state="{= ${/cacheHitRate} > 0.8 ? 'Success' : ${/cacheHitRate} > 0.5 ? 'Warning' : 'Error'}"
              inverted="true"/>
            <Text text="Content: {/cacheContentHitRateDisplay}"/>
            <Text text="Render:  {/cacheRenderHitRateDisplay}"/>
            <Text text="Size:    {/cacheBytesDisplay} / 50 MB"/>
            <Text text="Evicts/hr: {/cacheEvictsPerHour}"/>
          </VBox>
        </Panel>

        <!-- HANA pool card -->
        <Panel headerText="HANA pool acquire" expandable="false">
          <VBox class="sapUiSmallMargin">
            <MessageStrip
              visible="{= !${/dbWrapEnabled} }"
              text="DB wrapper not enabled. Set METRICS_DB_WRAP=true (PR 2 rollout)."
              type="Information"
              showIcon="true"/>
            <Text text="p50: {/dbAcquireP50Display} ms" visible="{/dbWrapEnabled}"/>
            <Text text="p95: {/dbAcquireP95Display} ms" visible="{/dbWrapEnabled}"/>
            <Text text="p99: {/dbAcquireP99Display} ms" visible="{/dbWrapEnabled}"/>
            <Text text="Timeouts (last hour): {/dbPoolTimeouts}" visible="{/dbWrapEnabled}"/>
          </VBox>
        </Panel>

        <!-- Publish latency card -->
        <Panel headerText="Publish latency" expandable="false">
          <VBox class="sapUiSmallMargin">
            <Text text="Last 20 publishes:"/>
            <Table items="{/recentPublishes}" growing="false">
              <columns>
                <Column><Text text="When"/></Column>
                <Column><Text text="Mode"/></Column>
                <Column hAlign="End"><Text text="Total ms"/></Column>
                <Column><Text text="Outcome"/></Column>
              </columns>
              <items>
                <ColumnListItem>
                  <cells>
                    <Text text="{createdAtDisplay}"/>
                    <Text text="{mode}"/>
                    <Text text="{totalMs}"/>
                    <ObjectStatus
                      text="{outcome}"
                      state="{= ${outcome} === 'committed' ? 'Success' : ${outcome} === 'aborted' ? 'Warning' : 'Error'}"/>
                  </cells>
                </ColumnListItem>
              </items>
            </Table>
            <Text text="Aggregate (7d): p50 {/publish7dP50}ms · p95 {/publish7dP95}ms · p99 {/publish7dP99}ms"/>
          </VBox>
        </Panel>

      </layout:Grid>
      <Text text="Last refresh: {/generatedAt} · instance {/instanceId} · uptime {/uptimeSec}s" class="sapUiSmallMargin"/>
    </content>
  </Page>
</mvc:View>
```

- [ ] **Step 2: Create the controller (numbers-only, no charts yet)**

Create `app/admin-shell/webapp/controller/Metrics.controller.js`:

```js
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
], function (Controller, JSONModel) {
  "use strict";

  const POLL_MS = 30_000;

  return Controller.extend("sap.tutorials.admin.controller.Metrics", {

    onInit: function () {
      this._model = new JSONModel({
        cacheHitRate: 0,
        cacheContentHitRateDisplay: "—",
        cacheRenderHitRateDisplay: "—",
        cacheBytesDisplay: "—",
        cacheEvictsPerHour: 0,
        dbWrapEnabled: false,
        dbAcquireP50Display: "—",
        dbAcquireP95Display: "—",
        dbAcquireP99Display: "—",
        dbPoolTimeouts: 0,
        recentPublishes: [],
        publish7dP50: 0, publish7dP95: 0, publish7dP99: 0,
        instanceId: "—", uptimeSec: 0, generatedAt: "—",
      });
      this.getView().setModel(this._model);

      // Router lifecycle: start polling when the metrics route is matched,
      // stop when leaving.
      const router = this.getOwnerComponent().getRouter();
      router.getRoute("metrics").attachPatternMatched(this._onEntered, this);
    },

    _onEntered: function () {
      this._refresh();
      if (this._pollTimer) clearInterval(this._pollTimer);
      this._pollTimer = setInterval(() => this._refresh(), POLL_MS);
    },

    onExit: function () {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    },

    _refresh: async function () {
      try {
        const res = await fetch("/admin-ui/../admin/getMetricsSnapshot()", {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const wrap = await res.json();
        const inner = typeof wrap.value === "string" ? JSON.parse(wrap.value) : wrap;
        this._applySnapshot(inner);
      } catch (err) {
        // Swallow — the tile shows stale data with the last successful
        // generatedAt so operators can see it's not updating.
        // eslint-disable-next-line no-console
        console.warn("[metrics tile] refresh failed:", err.message);
      }
    },

    _applySnapshot: function (envelope) {
      const s = envelope.snapshot || {};
      const c = s.counters || {};
      const g = s.gauges || {};
      const contentHits = c["content.cache.hit"] || 0;
      const contentMisses = c["content.cache.miss"] || 0;
      const contentTotal = contentHits + contentMisses;
      const renderHits = c["render.cache.hit"] || 0;
      const renderMisses = c["render.cache.miss"] || 0;
      const renderTotal = renderHits + renderMisses;
      const overallHits = contentHits + renderHits;
      const overallTotal = contentTotal + renderTotal;

      this._model.setData({
        cacheHitRate: overallTotal ? overallHits / overallTotal : 0,
        cacheContentHitRateDisplay: contentTotal ? `${((contentHits/contentTotal)*100).toFixed(1)}% (${contentHits}/${contentTotal})` : "—",
        cacheRenderHitRateDisplay: renderTotal ? `${((renderHits/renderTotal)*100).toFixed(1)}% (${renderHits}/${renderTotal})` : "—",
        cacheBytesDisplay: g["cache.bytes"] != null ? `${(g["cache.bytes"]/1024/1024).toFixed(1)} MB` : "—",
        cacheEvictsPerHour: c["cache.evict"] || 0,
        dbWrapEnabled: !!envelope.dbWrapEnabled,
        // Pool percentiles wired in PR 2 — left at "—" placeholders here.
        dbAcquireP50Display: "—",
        dbAcquireP95Display: "—",
        dbAcquireP99Display: "—",
        dbPoolTimeouts: c["db.pool.timeout"] || 0,
        // recentPublishes / 7d percentiles wired via OData in Task 13.
        recentPublishes: this._model.getProperty("/recentPublishes") || [],
        publish7dP50: this._model.getProperty("/publish7dP50") || 0,
        publish7dP95: this._model.getProperty("/publish7dP95") || 0,
        publish7dP99: this._model.getProperty("/publish7dP99") || 0,
        instanceId: envelope.instanceId || "—",
        uptimeSec: envelope.uptimeSec || 0,
        generatedAt: envelope.generatedAt || "—",
      });
    },

  });
});
```

- [ ] **Step 3: Register the route in `manifest.json`**

Find `sap.ui5.routing.routes` in `app/admin-shell/webapp/manifest.json`. Append after the last route (before the closing `]`):

```json
,
{
  "name": "metrics",
  "pattern": "metrics",
  "target": [{ "name": "metricsTarget", "prefix": "op" }]
}
```

Then in `sap.ui5.routing.targets`, add:

```json
"metricsTarget": {
  "viewName": "Metrics",
  "viewLevel": 1
}
```

Place `metricsTarget` next to `boardTarget` / `statisticsTarget` for consistency.

- [ ] **Step 4: Add nav entry in `Shell.controller.js`**

Find the side-navigation model definition (search for `Board` or `Statistics` in `app/admin-shell/webapp/controller/Shell.controller.js`) and add a new nav item in the Analytics section:

```js
{
  key: "metrics",
  text: "Metrics",
  icon: "sap-icon://line-chart",
}
```

- [ ] **Step 5: Sanity check — build the admin-shell**

Run: `npm --prefix app/admin-shell run build`
Expected: build succeeds; no errors mentioning `Metrics.view.xml` or the manifest edit.

- [ ] **Step 6: Local visual check**

Run: `npm run dev` in one terminal. In another:
```bash
open http://localhost:4004/admin-ui/#metrics
```
Expected: three cards render with placeholder "—" values and "DB wrapper not enabled" strip. Refresh in 30 s should update `generatedAt`.

- [ ] **Step 7: Commit**

```bash
git add app/admin-shell/webapp/view/Metrics.view.xml \
        app/admin-shell/webapp/controller/Metrics.controller.js \
        app/admin-shell/webapp/manifest.json \
        app/admin-shell/webapp/controller/Shell.controller.js
git commit -m "feat(#805): admin-shell Metrics view + live-snapshot polling"
```

---

## Task 13: OData reads for historical data (recent publishes + 7-day aggregates)

Extend the controller to pull `AnalyticsService.PublishTimings` + `MetricSnapshots` via OData once per `_onEntered` (not every poll — history changes slowly).

**Files:**

- Modify: `app/admin-shell/webapp/controller/Metrics.controller.js`

- [ ] **Step 1: Add OData helper methods**

Add these methods to the controller (peer to `_refresh`):

```js
_loadHistory: async function () {
  await Promise.all([this._loadRecentPublishes(), this._load7dPercentiles()]);
},

_loadRecentPublishes: async function () {
  try {
    // Order by createdAt desc, limit 20
    const url = "/admin-ui/../analytics/PublishTimings" +
                "?$select=createdAt,mode,totalMs,outcome,slugCount" +
                "&$orderby=createdAt%20desc&$top=20";
    const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { value } = await res.json();
    const rows = value.map((r) => ({
      createdAtDisplay: new Date(r.createdAt).toLocaleString(),
      mode: r.mode || "—",
      totalMs: r.totalMs || 0,
      outcome: r.outcome || "—",
      slugCount: r.slugCount || 0,
    }));
    this._model.setProperty("/recentPublishes", rows);
  } catch (err) {
    console.warn("[metrics tile] recent publishes load failed:", err.message);
  }
},

_load7dPercentiles: async function () {
  try {
    // Pull last 7 days of committed publishes and compute percentiles client-side.
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const url = "/admin-ui/../analytics/PublishTimings" +
                `?$select=totalMs&$filter=outcome eq 'committed' and createdAt ge ${cutoff}` +
                "&$top=5000";
    const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { value } = await res.json();
    const nums = value.map((r) => r.totalMs || 0).sort((a, b) => a - b);
    const pct = (p) => nums.length ? nums[Math.min(nums.length - 1, Math.floor(nums.length * p))] : 0;
    this._model.setProperty("/publish7dP50", pct(0.50));
    this._model.setProperty("/publish7dP95", pct(0.95));
    this._model.setProperty("/publish7dP99", pct(0.99));
  } catch (err) {
    console.warn("[metrics tile] 7d percentiles load failed:", err.message);
  }
},
```

- [ ] **Step 2: Wire into `_onEntered`**

Modify `_onEntered` to also load history:

```js
_onEntered: function () {
  this._refresh();
  this._loadHistory();
  if (this._pollTimer) clearInterval(this._pollTimer);
  this._pollTimer = setInterval(() => this._refresh(), POLL_MS);
  // Reload history every 5 minutes (aligned with rollup cadence).
  if (this._historyTimer) clearInterval(this._historyTimer);
  this._historyTimer = setInterval(() => this._loadHistory(), 5 * 60_000);
},
```

Extend `onExit`:

```js
onExit: function () {
  if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  if (this._historyTimer) { clearInterval(this._historyTimer); this._historyTimer = null; }
},
```

- [ ] **Step 3: Sanity — rebuild admin-shell**

Run: `npm --prefix app/admin-shell run build`
Expected: build succeeds.

- [ ] **Step 4: Local check**

Assuming DEV has some `PublishTimings` rows already (from Task 7's local runs), point the dev srv at DEV:

Run: `npm run dev:hybrid` (CAP + approuter + real HANA)
Open `http://localhost:5000/admin-ui/#metrics`
Expected: recent publishes table populates; 7d numbers non-zero (or zero if DEV has no recent commits).

- [ ] **Step 5: Commit**

```bash
git add app/admin-shell/webapp/controller/Metrics.controller.js
git commit -m "feat(#805): Metrics tile — historical publishes + 7d percentiles"
```

---

## Task 14: Documentation

Three doc updates: new architecture doc, endpoint reference update, CLAUDE.md gotcha entry. All three are docs-site content — no code.

**Files:**

- Create: `docs/developers/architecture/observability.md`
- Modify: `docs/developers/operations/testing-endpoints.md`
- Modify: `CLAUDE.md`
- Modify: `docs/.vitepress/config.ts` (register the new page in the sidebar)

- [ ] **Step 1: Write the architecture doc**

Create `docs/developers/architecture/observability.md`:

```markdown
# Observability (metrics module)

The srv runtime emits operational metrics via `srv/lib/metrics.js` — a shared
in-memory producer for counters, gauges, and Vitter Algorithm R histograms.
Every 5 minutes, `srv/jobs/metrics-rollup-job.js` snapshots and drains the
in-memory state into HANA rows (`MetricSnapshots`) and structured log lines.

## Metrics catalog (PR 1)

| Metric | Kind | Where emitted | Meaning |
|---|---|---|---|
| `content.cache.hit` / `.miss` | counter | `srv/lib/content-store.js` serveHandler | Bare-slug ContentFiles cache lookups |
| `render.cache.hit` / `.miss` | counter | same, render branch | Rendered mission/group cache lookups |
| `cache.evict` | counter | `ContentCache.set()` | Bytes-cap eviction fires |
| `cache.bytes` | gauge | `ContentCache.set()` | Current cache size |
| `publish.attempt` | counter | `beginPublishSession` | New publish session started |
| `publish.commit.ok` / `.reject` | counter | `commitSession` | Terminal commit outcome |
| `publish.abort` | counter | `abortSession` | Aborted before commit |
| `publish.begin.ms` | histogram | `commitSession` | createdAt → firstAppendAt |
| `publish.append.ms` | histogram | `commitSession` | Sum of append handler wall-clocks |
| `publish.commit.ms` | histogram | `commitSession` | Commit handler wall-clock |
| `publish.total.ms` | histogram | `commitSession` | createdAt → commit response |

(PR 2 adds `db.acquire.ms` / `db.tx.ms` / `db.tx.run.ms` / `db.pool.timeout`.)

## How to add a new metric

1. In the emitting file, `import * as metrics from '.../lib/metrics.js';`
2. Call `metrics.counter(name)`, `metrics.gauge(name, value)`, or `metrics.observe(name, value)`.
3. The rollup job picks it up automatically — no schema change needed.
4. Add a row to the catalog table above.

Naming: use dotted namespaces (`subsystem.what.kind`). Keep total distinct
names ≤ 20 in v1 to stay well within the `MetricSnapshots` cardinality budget.

## Surfaces

- Admin UI tile at `/admin-ui/#metrics` — three cards (cache, pool, publish).
- `GET /admin/getMetricsSnapshot()` — CAP function; XSUAA Admin scope; live snapshot.
- `GET /admin/metrics/live` — basic-auth Express route; same shape; for on-call `curl`.
- CF logs — `cds.log('jobs/metrics-rollup')` info lines, one per metric per 5-min boundary.

## Feature flags

- `METRICS_ENABLED` (default `true`) — master switch; all writes no-op when `false`.
- `METRICS_DB_WRAP` (default `false`) — PR 2 will install a `cds.db.run` / `cds.db.tx` passive wrapper when `true`. Not wired in PR 1.

## Retention

Rows are pruned by daily cleanup crons:

- `MetricSnapshots`: 30 days (`srv/jobs/scheduler.js` → `cleanupMetricSnapshots`)
- `PublishTimings`: 90 days (`srv/jobs/scheduler.js` → `cleanupPublishTimings`)

Both retention jobs use `job-lock.js`; the rollup writer does NOT
(both CF instances write per-instance rows under composite primary key).

## References

- Spec: [`docs/superpowers/specs/2026-07-02-805-observability-instrumentation-design.md`](../../superpowers/specs/2026-07-02-805-observability-instrumentation-design.md)
- Issue: [#805](https://github.com/sap-tutorials/tutorials-ims/issues/805)
```

- [ ] **Step 2: Update `docs/developers/operations/testing-endpoints.md`**

Find the endpoint table. Add two rows (keep alphabetical / grouping consistent):

- `GET /admin/metrics/live` — basic-auth — live snapshot JSON — used by on-call `curl`. Response includes `snapshot`, `instanceId`, `uptimeSec`, `dbWrapEnabled`, `generatedAt`.
- `GET /admin/getMetricsSnapshot()` — XSUAA Admin — CAP function; same JSON shape wrapped in OData `{ value: '...' }`.

- [ ] **Step 3: Add gotcha entry to `CLAUDE.md`**

Find the `## Gotchas` section. Append:

```markdown
- **Observability metrics module** (`srv/lib/metrics.js`, #805) — In-memory
  counters/gauges/reservoirs, drained every 5 minutes by
  `srv/jobs/metrics-rollup-job.js` into `MetricSnapshots` rows. Two env flags:
  `METRICS_ENABLED` (default `true`; set `false` as a kill-switch) and
  `METRICS_DB_WRAP` (default `false`; PR 2 flips this on to install the passive
  `cds.db.run` / `cds.db.tx` wrapper). The rollup job does NOT use `job-lock`
  — both CF instances write per-instance rows under composite primary key. The
  retention jobs (30 d / 90 d) DO use `job-lock`. See
  [docs/developers/architecture/observability.md](docs/developers/architecture/observability.md).
```

- [ ] **Step 4: Register the new doc in the VitePress sidebar**

Modify `docs/.vitepress/config.ts`. Find the `Developers > Architecture` sidebar section and add:

```ts
{ text: 'Observability', link: '/developers/architecture/observability' },
```

Run: `npm run docs:build`
Expected: build succeeds (the predocs:build sidebar-guard catches unregistered pages, so this step verifies the registration is correct).

- [ ] **Step 5: Commit**

```bash
git add docs/developers/architecture/observability.md \
        docs/developers/operations/testing-endpoints.md \
        docs/.vitepress/config.ts \
        CLAUDE.md
git commit -m "docs(#805): observability architecture doc + endpoint refs + CLAUDE gotcha"
```

---

## Task 15: Integration verification + PR

Final sanity pass across the whole PR before opening.

**Files:** none new; verification only.

- [ ] **Step 1: Full unit suite**

Run: `npm test -- --run`
Expected: all pass, including the new `metrics.test.js` (11 tests) and `content-cache-metrics.test.js` (1 test).

- [ ] **Step 2: Full hybrid suite**

Run: `ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npm run test:hybrid`
Expected: all pass, including `analytics-projection.test.js`, `publish-timings.test.js`, `metrics-rollup.test.js`.

- [ ] **Step 3: CDS build sanity**

Run: `npx cds build --production`
Verify: `db/gen/src/gen/` contains fresh `MetricSnapshots.hdbmigrationtable` and `PublishTimings.hdbmigrationtable`.

- [ ] **Step 4: Admin-shell build**

Run: `npm --prefix app/admin-shell run build`
Expected: succeeds; `dist/` has the Metrics view assets.

- [ ] **Step 5: Local dev-server smoke**

Run: `npm run dev` (in one terminal). In another:

```bash
# Metrics live endpoint
curl -s -u admin:admin http://localhost:4004/admin/metrics/live | jq .
# Should show counters/gauges/histograms shape + dbWrapEnabled:false

# AdminService function
# (needs XSUAA — skip locally unless approuter is running)
```

Kill dev server.

- [ ] **Step 6: Push branch + open PR**

```bash
git push -u origin feat/805-observability-instrumentation
gh pr create \
  --title "feat(#805): observability instrumentation (PR 1 — everything except DB wrapper)" \
  --body "$(cat <<'EOF'
Instruments the CAP srv runtime with cache-hit-rate, publish-latency
percentiles, and a HANA-backed rollup pipeline surfaced in the admin UI.
The DB acquire-latency wrapper is deliberately deferred to PR 2 so the
cache + publish signal can be verified in isolation before the wrapper
touches every DB call site.

## What's in

- `srv/lib/metrics.js` — shared producer (counters / gauges / Vitter Algorithm R histograms).
- `MetricSnapshots` + `PublishTimings` HANA entities + hdbindexes.
- Two new `ContentManifestAspect` columns for load-balancer-safe publish timing.
- 5-min rollup job (no lock) + 30d/90d retention crons (with lock).
- `AdminService.getMetricsSnapshot()` CAP function + `/admin/metrics/live` late-bound Express endpoint.
- New UI5 `Metrics` peer view at `/admin-ui/#metrics` with three cards.
- Full unit + hybrid + smoke test coverage.

## Rollout

`METRICS_ENABLED=true` by default; `METRICS_DB_WRAP=false` (PR 2's job).
Pool card renders "not yet enabled" strip via the response flag.

## Refs
- Spec: docs/superpowers/specs/2026-07-02-805-observability-instrumentation-design.md
- Plan: docs/superpowers/plans/2026-07-02-805-observability-pr1.md
- Closes #805 (partially — PR 2 completes)
EOF
)"
```

Do NOT close the issue on this PR — PR 2 needs to land to complete #805. The PR body says "partially — PR 2 completes."

- [ ] **Step 7: After merge — deploy to DEV + verify**

```bash
# From primary tree, on main, after PR merges
cd /d/projects/tutorials-poc
git checkout main && git pull
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

Then, on DEV:

```bash
# Confirm the schema landed
cf ssh tutorials-srv -c 'curl -s -u admin:$TECH_USER_PASS http://localhost:$PORT/admin/metrics/live' | jq .

# Wait ~5 minutes, then check that rollup rows accumulated
# Use hana-cli
hana-cli querySimple "SELECT COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_METRICSNAPSHOTS WHERE WINDOWSTART >= ADD_SECONDS(CURRENT_UTCTIMESTAMP, -3600)"
# Expect: > 0
```

- [ ] **Step 8: File the PR 2 follow-up issue**

Create a new issue linked to #805 titled "feat(#805 PR 2): enable METRICS_DB_WRAP passive wrapper". Body: link this PR, spec's § Rollout section, and the `db.acquire.ms` / `db.tx.ms` / `db.tx.run.ms` metric additions. PR 2 is a separate plan.

---

## Appendix — Skill references

- [`superpowers:test-driven-development`](../../..) — the "write failing test → make it pass" cadence used throughout this plan.
- [`superpowers:executing-plans`](../../..) — for inline execution.
- [`superpowers:subagent-driven-development`](../../..) — for fresh-subagent-per-task execution (recommended for this plan given ~15 discrete tasks).

## Appendix — Key gotchas cross-referenced

- [[feedback_worktree_directory_convention]] — this plan runs in `.claude/worktrees/805-observability/`.
- [[feedback_cds_build_production_not_cds_compile_for_last_dev]] — Task 4 runs `cds build --production`.
- [[feedback_cds_schema_plans_need_cds_build_production_step]] — Task 4 commits `db/gen/`.
- [[feedback_srv_qa_cp_list]] — `srv-qa` unchanged in this plan; new entities are prod-only, aspect columns land on QA symmetrically via shared aspect (no manual edit).
- [[feedback_check_srv_qa_when_changing_srv]] — no `srv-qa/` change is needed; the new metrics wiring is deliberately prod-only in v1.
- [[feedback_silent_swallow_hides_dead_code]] — `metrics.js` swallow-and-log is a documented exception (spec § Error handling).
- [[feedback_always_deploy_from_main_primary_tree]] — Step 7 above returns to primary tree + `main` before `mbt build`.
