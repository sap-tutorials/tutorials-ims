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

- Admin UI at `/admin-ui/#metrics` — three cards (cache, pool, publish).
- `GET /admin/getMetricsSnapshot()` — CAP function; XSUAA Admin scope; live snapshot.
- `GET /admin/metrics/live` — Express route; Admin scope required (`user.is('Admin')`); same shape; for on-call `curl` via XSUAA-authenticated session.
- CF logs — `cds.log('jobs/metrics-rollup')` info lines, one per metric per 5-min boundary.

## Feature flags

- `METRICS_ENABLED` (default `true`) — master switch; all writes no-op when `false`.
- `METRICS_DB_WRAP` (default `false`) — PR 2 installs `cds.db.run` / `cds.db.tx` passive wrapper when `true`. Not wired in PR 1.

## Retention

Daily cleanup crons:

- `MetricSnapshots`: 30 days (`srv/jobs/scheduler.js` → `cleanupMetricSnapshots`)
- `PublishTimings`: 90 days (`srv/jobs/scheduler.js` → `cleanupPublishTimings`)

Both retention jobs use `job-lock.js`; the rollup writer does NOT
(both CF instances write per-instance rows under composite primary key).

## References

- Spec: [`docs/superpowers/specs/2026-07-02-805-observability-instrumentation-design.md`](../../superpowers/specs/2026-07-02-805-observability-instrumentation-design.md)
- Issue: [#805](https://github.com/sap-tutorials/tutorials-ims/issues/805)
