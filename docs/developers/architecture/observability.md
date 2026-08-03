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
| `homepage.community_blogs[result=served\|degraded\|degraded_empty\|error]` | counter | `srv/homepage-service.js` communityBlogs | Shelf serve outcome |
| `homepage.community_blogs.classifier.{drained,ok,parse_error,aicore_error}` | counter | `srv/lib/community-blogs-classifier.js` | Per-drain classifier counts |
| `homepage.community_blogs.fetch[result=hit\|fetch_error\|parse_error]` | counter | `srv/lib/community-blogs-fetcher.js` | Per-source fetch outcome |
| `homepage.community_blogs.fetch.{inserted,updated}` | counter | `srv/lib/community-blogs-fetcher.js` | Rows inserted/updated per fetch |
| `homepage.events.refresh.{ok,partial,failed}` | counter | `srv/jobs/refresh-community-events-job.js` | Events refresh outcome |
| `homepage.events.refresh_rows.{inserted,updated}` | counter | `srv/jobs/refresh-community-events-job.js` | Rows inserted/updated per refresh |

The DB-wrapper metrics (`db.*`) only emit when `METRICS_DB_WRAP=true`. Metrics module is otherwise unconditionally active.

## How to add a new metric

1. In the emitting file, `import * as metrics from '.../lib/metrics.js';`
2. Call `metrics.counter(name)`, `metrics.gauge(name, value)`, or `metrics.observe(name, value)`.
3. The rollup job picks it up automatically — no schema change needed.
4. Add a row to the catalog table above.
5. **Names are capped at 64 chars** (`MAX_NAME_LEN` in `metrics.js`, mirroring
   the `MetricSnapshots.metric` `String(64)` primary key). Never interpolate
   counts or unbounded ids into a name — put counts in their own dotted counter
   (`counter(name, n)`) and keep only bounded dimensions in `[key=value]` tags.
   Over-length names are dropped at ingestion with a warning, never persisted.

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

---

# Alerting (SAP Alert Notification Service)

The alerting layer escalates a **subset of failures that need a human** to the
`devrel-oncall` distribution list via SAP Alert Notification Service (ANS). It
sits **beside** the metrics module and structured logs — it does not replace
them. The metrics module is unchanged; alerting adds a push signal on the
failure paths where passive dashboards are not enough.

## Implementation

`srv/lib/alerting.js` exports a single `raise(input)` helper. It is:

- **Fail-open** — all errors are caught and warn-logged; the alert never throws
  into or blocks the call path it watches.
- **Default off** — no-ops unless `ALERTS_ENABLED=true` is set in the CF
  environment.
- **Memoised** — `cds.connect.to('alerts')` is called once; the promise is
  cleared on error to allow reconnect on the next raise.

The helper mirrors `metrics.js` in calling convention: import as a namespace,
call the exported function directly, never `await` from the failure path (use
`void alerting.raise(...)`).

## Alerted failure paths

| Hook site | File | `eventType` | When raised |
|---|---|---|---|
| Content-publish soft-reject | `srv/lib/content-publish-session.js` `commitSession` | `PublishRejected` | `outcome === 'rejected'` — one or more slug reverts were blocked; content partially published |
| Scheduled job failure | `srv/jobs/scheduler.js` `runWithLock` catch | `ScheduledJobFailed` | Any scheduled job throws; `resource.resourceName` = job name; deduplicates per job via ANS `dedupWindowMs` |
| Rebuild dispatch failure | `srv/lib/rebuild-trigger.js` dispatch catch | `RebuildDispatchFailed` | GitHub Actions dispatch throws; admin save already succeeded; next trigger picks up the miss |

All three hooks use `severity: 'ERROR'` and `category: 'ALERT'`.
`ScheduledJobFailed` covers **every** scheduled job (metrics-rollup, KG
nightly jobs, community-events refresh, etc.) through the single chokepoint in
`runWithLock`.

## Configuration

In `package.json` `cds.requires.alerts`:

```json
"alerts": {
  "impl": "@sap-devrel/cds-alert-notification",
  "kind": "alert-notification-console",
  "[test]":       { "kind": "alert-notification-memory" },
  "[hybrid]":     { "kind": "alert-notification" },
  "[production]": { "kind": "alert-notification" },
  "channels": ["email:devrel-oncall"],
  "routes": [{ "minSeverity": "ERROR", "channels": ["email:devrel-oncall"] }],
  "eventTypes": ["PublishRejected", "ScheduledJobFailed", "RebuildDispatchFailed"],
  "dedupWindowMs": 300000
}
```

- `alert-notification-console` — local `cds watch` logs alerts to stdout only
  (no ANS traffic, no quota).
- `alert-notification-memory` — unit-test profile; alerts accumulate in memory
  for assertion.
- `alert-notification` — hybrid/production; posts to the bound ANS service
  instance via `cds.outboxed()`.
- `dedupWindowMs: 300000` — 5-minute dedup window; repeated failures of the
  same job within the window produce one email, not a flood.

## Plugin dependency

The plugin is `@sap-devrel/cds-alert-notification` v1.0.0, declared as a
**git dependency** pointing to an internal GitHub instance
(`github.tools.sap`):

```
"@sap-devrel/cds-alert-notification":
  "git+https://github.tools.sap/developer-relations/cds-alert-notification.git#v1.0.0"
```

This means `npm install` requires network access to `github.tools.sap`.
Workstations with a global `allow-git: none` npmrc cannot install it locally.
CI and CF deploy pipelines do not have that restriction, so standard deploys
work. If the plugin is ever moved to an internal npm registry, update the
dependency accordingly and remove this caveat.

## Feature flag

- `ALERTS_ENABLED` (default `false` / absent) — master switch for the helper.
  Set to `'true'` to enable; any other value (including unset) silently skips
  every `raise()` call.

## Operator post-merge checklist

These steps cannot be performed from a PR and must be completed after the MTA
is deployed.

**1. Confirm plugin install succeeds in the deploy pipeline.**
The plugin is a git-dep from `github.tools.sap`. Before deploying, verify that
the CI/CF npm install can clone it. If not (e.g. a pip/npm proxy blocks
`github.tools.sap`), publish the plugin to an internal npm registry first and
update the dependency reference in `package.json`.

**2. Deploy the MTA (v1.10.0).**
`.deploy/mta.yaml` declares `tutorials-alert-notification` as a managed
`alert-notification` service (plan `standard`). The `mbt build` + `cf deploy`
run provisions the instance and binds it to `tutorials-srv`. No manual `cf
create-service` is needed.

**3. Bind the email action to the `devrel-oncall` distribution list.**
The MTA creates the ANS **instance** but does NOT configure email routing —
that requires a post-deploy step in the ANS cockpit (or via the plugin's
generated `provision.sh`). Open the ANS cockpit for the `tutorial-system`
subaccount, locate the `tutorials-alert-notification` instance, and create an
email ACTION pointing to the real `devrel-oncall` distribution-list address.
Wire it to the `devrel-oncall` CONDITION (minSeverity ERROR). Without this step
the instance is bound but no emails are sent.

**4. Enable alerting.**

```bash
cf target -s dev   # confirm space before set-env
cf set-env tutorials-srv ALERTS_ENABLED true
cf restart tutorials-srv
```

**5. Live-verify one alert end-to-end.**
Trigger a known failure (e.g. a publish-reject via the admin UI with a
deliberately bad slug, or force a scheduled job error in DEV) and confirm the
email arrives at the `devrel-oncall` address. This is the **one path not proven
by any automated test** — the unit tests assert the helper contract and envelope
shapes in memory, but `cds.outboxed()` posting to a real ANS endpoint has not
been exercised against a live CAP runtime. This live-verify is **mandatory**
before declaring the integration done.

**6. Confirm Node runtime floor.**
`package.json` now declares `"engines": { "node": ">=22.12" }` (the plugin's
requirement). Verify the CF buildpack runtime satisfies this before deploying
to PROD. The CI pipeline already runs Node 22; the CF Node.js buildpack default
should be ≥22.12 — confirm with `cf env tutorials-srv | grep VCAP_APPLICATION`
after deploy and check the buildpack version log.

## Surfaces

- CF logs — `cds.log('alerting')` warn lines on any raise failure (e.g. ANS
  unreachable, `ALERTS_ENABLED` off).
- ANS cockpit — alert history under the `tutorials-alert-notification`
  instance.
- No admin-UI tile in v1 — the metrics module's existing `/admin-ui/#metrics`
  is unchanged; alerting is a push channel only.

## References

- Spec: [`docs/superpowers/specs/2026-08-03-ans-integration-tutorials-ims/spec.md`](../../superpowers/specs/2026-08-03-ans-integration-tutorials-ims/spec.md) (if present)
- Issue: ANS integration tracking issue (see PR description for link)
