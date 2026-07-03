# Observability (metrics module)

The srv runtime emits operational metrics via `srv/lib/metrics.js` — a shared
in-memory producer for counters, gauges, and Vitter Algorithm R histograms.
Every 5 minutes, `srv/jobs/metrics-rollup-job.js` snapshots and drains the
in-memory state into HANA rows (`MetricSnapshots`) and structured log lines.

## Metrics catalog

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
| `db.acquire.ms` | histogram | `srv/lib/metrics-db-wrap.js` (PR 2) | Every `cds.db.run(...)` wall-clock — pool acquire + query |
| `db.tx.ms` | histogram | same | Every `db.tx(fn)` end-to-end wall-clock |
| `db.tx.run.ms` | histogram | same | Every `tx.run(...)` inside a tx callback |
| `db.pool.timeout` | counter | same | Rejected error matches `/timeout|acquire/i` |

The DB-wrapper metrics (`db.*`) only emit when `METRICS_DB_WRAP=true`. Metrics module is otherwise unconditionally active.

## How to add a new metric

1. In the emitting file, `import * as metrics from '.../lib/metrics.js';`
2. Call `metrics.counter(name)`, `metrics.gauge(name, value)`, or `metrics.observe(name, value)`.
3. The rollup job picks it up automatically — no schema change needed.
4. Add a row to the catalog table above.

Naming: use dotted namespaces (`subsystem.what.kind`). Keep total distinct
names ≤ 20 in v1 to stay well within the `MetricSnapshots` cardinality budget.

## Surfaces

- Admin UI at `/admin-ui/#metrics` — three cards (cache, pool, publish).
- `GET /admin/getMetricsSnapshot()` — CAP function; XSUAA Admin scope; live snapshot.
- `GET /admin/metrics/live` — Express route; Admin scope required (`user.is('Admin')`); same shape; for on-call `curl` via XSUAA-authenticated session.
- CF logs — `cds.log('jobs/metrics-rollup')` info lines, one per metric per 5-min boundary.

## Feature flags

- `METRICS_ENABLED` (default `true`) — master switch; all writes no-op when `false`.
- `METRICS_DB_WRAP` (default `false`) — when `true`, installs the passive `cds.db.run` / `cds.db.tx` wrapper at `cds.on('served')` time.

### DB-wrapper rollout

The wrapper lives in [`srv/lib/metrics-db-wrap.js`](../../../srv/lib/metrics-db-wrap.js). It patches `cds.db.run` and `cds.db.tx` (NOT `cds.tx` — that resolves against the `cds` module rather than the DB service and would miss every `db.tx(...)` call). The 3 `cds.tx(...)` sites ([`srv/lib/repo-catalog.js`](../../../srv/lib/repo-catalog.js), [`srv/lib/category-classifier.js`](../../../srv/lib/category-classifier.js), [`srv/lib/validate-answer-spec-publish.js`](../../../srv/lib/validate-answer-spec-publish.js)) stay un-instrumented in v1 — they aren't pool-starving paths.

Enable / disable:

```bash
# Enable in DEV
cf set-env tutorials-srv METRICS_DB_WRAP true
cf restart tutorials-srv

# Kill switch (either works — the wrapper checks both)
cf set-env tutorials-srv METRICS_DB_WRAP false && cf restart tutorials-srv
cf set-env tutorials-srv METRICS_ENABLED false && cf restart tutorials-srv
```

Watch `/admin-ui/#metrics` pool card for the first tick (~5 min after restart). The card renders `dbWrapEnabled: true` when the flag is on.

Idempotency: the wrapper installs exactly once per process via `globalThis.__metricsDbWrapInstalled`. `cds.on('served')` can re-fire under `cds.test()`; the sentinel prevents double-wrap (which would compose two layers of timing).

Caveats to read the histograms with:

- Timing conflates acquire time and query time — no driver hook separates them. A p95 rise with unchanged query mix is the pool-exhaustion signal.
- Nested-tx short-circuit in `@sap/cds/lib/srv/srv-tx.js` means the outer `db.tx.ms` observation can double-count against the wall-clock of an already-active tx. Not a correctness issue — read the percentiles as "acquire + tx pressure signal" not "unique wall-clock samples."

## Retention

Daily cleanup crons:

- `MetricSnapshots`: 30 days (`srv/jobs/scheduler.js` → `cleanupMetricSnapshots`)
- `PublishTimings`: 90 days (`srv/jobs/scheduler.js` → `cleanupPublishTimings`)

Both retention jobs use `job-lock.js`; the rollup writer does NOT
(both CF instances write per-instance rows under composite primary key).

## References

- Spec: [`docs/superpowers/specs/2026-07-02-805-observability-instrumentation-design.md`](../../superpowers/specs/2026-07-02-805-observability-instrumentation-design.md)
- Issue: [#805](https://github.com/sap-tutorials/tutorials-ims/issues/805)
