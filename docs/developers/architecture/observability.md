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
- **Default off** — no-ops unless `ChatSettings.alertsEnabled` is `true`
  (admin-editable in the DB; see below).
- **Memoised** — `cds.connect.to('alerts')` is called once; the promise is
  cleared on error to allow reconnect on the next raise.

The helper mirrors `metrics.js` in calling convention: import as a namespace,
call the exported function directly, never `await` from the failure path (use
`void alerting.raise(...)`).

## Alerted failure paths

Routing is **by severity only** (`routes[]` in the config): `ERROR`+ →
`devrel-oncall`, `NOTICE`/`WARNING` → `devrel-deploys`. Per-`eventType` delivery
is filtered cockpit-side (see the wiring note below).

| Hook site | File | `eventType` | Severity | When raised |
|---|---|---|---|---|
| Content-publish soft-reject | `srv/lib/content-publish-session.js` `commitSession` | `PublishRejected` | ERROR | `outcome === 'rejected'` — one or more slug reverts were blocked; content partially published |
| Scheduled job failure | `srv/jobs/scheduler.js` `runWithLock` catch | `ScheduledJobFailed` | ERROR | Any scheduled job throws; `resource.resourceName` = job name; dedup per job via ANS `dedupWindowMs`. Covers **every** job through the single chokepoint |
| Rebuild dispatch failure | `srv/lib/rebuild-trigger.js` dispatch catch | `RebuildDispatchFailed` | ERROR | The GitHub Actions `workflow_dispatch` POST throws; the admin save already succeeded |
| Rebuild pipeline run failure | `srv/lib/content-store.js` `pipelineLogFailureHandler` (`POST /content/pipeline-log`) | `RebuildPipelineFailed` | ERROR | A `rebuild-content(-qa).yml` run fails and its `if: failure()` step reports here. ANS parity for the pipeline *run* (complements the workflow's GitHub-issue notifier, #1373). `resource.resourceName` = `rebuild-<env>` |
| Deploy lifecycle | `srv/routes/deploy-events.js` (`POST /ops/deploy-event`) | `DeployStarted` / `DeployFinished` / `DeployFailed` | NOTICE / NOTICE / ERROR | Pinged by `scripts/deploy-mta.cjs` at each deploy boundary |
| NGDS send exhausted | `srv/jobs/ngds-retry.js` (`buildRetryAlerts`) | `NgdsSendExhausted` | ERROR | The retry job marked ≥1 message `FAILED_PERMANENTLY` this run — badge events lost |
| NGDS backlog | `srv/jobs/ngds-retry.js` (`buildRetryAlerts`) | `NgdsBacklog` | WARNING | Retries failed this run, or pending backlog ≥ `BACKLOG_THRESHOLD` (20) — feed unhealthy |
| Secret expiring / missing | `srv/jobs/secret-expiry-check.js` (`buildSecretExpiryAlerts`) | `SecretExpiringSoon` | ERROR / WARNING | Daily check found ≥1 secret expired or **missing from credstore** (ERROR) or expiring within 7 days (WARNING). Proactive — fires on findings, not on job crash (#1718) |
| Homepage links broken | `srv/jobs/homepage-link-health.js` (`buildBrokenLinksAlert`) | `HomepageLinksBroken` | WARNING | Nightly link-health check found ≥1 BROKEN homepage link; pin `linkStatusOverride` to silence false-positives (#1718) |
| Publish manifest stuck | `srv/jobs/cleanup.js` `cleanupStuckPublishing` (`buildPublishStuckAlert`) | `PublishStuck` | WARNING | The watchdog force-FAILED ≥1 wedged `PUBLISHING` manifest and released its lock (#1718) |
| Admin test button | `srv/admin-service.js` `sendTestAlert` | `AlertingTest` | admin-chosen | On-demand end-to-end path check (see below) |

**Findings vs. crash alerts (#1718).** `ScheduledJobFailed` fires when a job
*throws*. `SecretExpiringSoon`, `HomepageLinksBroken`, and `PublishStuck` fire
when a job *completes successfully but returns actionable findings* — the job
computes a pure `buildXAlert(s)` decision (mirroring `buildRetryAlerts`) and
hands the envelope(s) to `alerting.raise()` itself, wrapping each with
`category: 'ALERT'` + `resource: { resourceName: <job>, resourceType: 'job' }`.
`tutorial-metadata-review` previously swallowed its own errors, hiding failures
from the crash chokepoint; it now re-throws so backfill drift surfaces (#1718).

## Testing the alert path (#1469)

An admin can verify the ANS code path end-to-end on demand — without forcing a
real failure — via **Send test alert** on `/admin-ui/#joule` (Operational
Alerting panel, beside the `alertsEnabled` toggle).

- The button invokes `AdminService.sendTestAlert`, which calls
  `alerting.raiseTest()` with a TEST envelope: `eventType: 'AlertingTest'`,
  `subject: '[TEST] Admin-triggered alert'`, `severity` defaulting to `ERROR`.
- `raiseTest()` is a result-returning sibling of `raise()` — same fail-open
  contract (never throws) but returns `{ outcome: 'delivered' | 'disabled' |
  'error', reason? }` so the admin sees whether it fired:
  - `disabled` — `ChatSettings.alertsEnabled` is false (doubles as an
    "is alerting on?" probe). Enable + Save first (~5s resolver cache).
  - `delivered` — handed to the ANS sink without error.
  - `error` — connect/raise threw; `reason` carries the message.
- Each click uses a **unique** `resource.resourceName`
  (`admin-test:<user>:<ISO-ts>`) so the plugin's 5-min dedup window never
  silently drops a test — every click actually fires.
- **Ops requirement:** `cds build` generates a matching `AlertingTest`
  condition into `ans-conditions.json` (from the `eventTypes` config); an
  operator then wires that condition to a subscription in the BTP cockpit for
  the target env, exactly like the three real eventTypes. The plugin routes
  alerts to channels by severity threshold only; per-eventType filtering
  happens in the BTP cockpit (condition matching on `eventType`). If the
  `AlertingTest` condition/subscription is absent, `raiseTest()` still reports
  `delivered` (our code did its job) but no email arrives — itself a useful
  signal that the ANS-side wiring is missing.

## Configuration

In `package.json` `cds.requires.alerts`:

```json
"alerts": {
  "impl": "@sap-tutorials/cds-alert-notification",
  "kind": "alert-notification-console",
  "[test]":       { "kind": "alert-notification-memory" },
  "[hybrid]":     { "kind": "alert-notification" },
  "[production]": { "kind": "alert-notification" },
  "channels": ["email:devrel-oncall", "email:devrel-deploys"],
  "routes": [
    { "minSeverity": "ERROR",  "channels": ["email:devrel-oncall"] },
    { "minSeverity": "NOTICE", "channels": ["email:devrel-deploys"] }
  ],
  "eventTypes": ["PublishRejected", "ScheduledJobFailed", "RebuildDispatchFailed", "RebuildPipelineFailed", "DeployStarted", "DeployFinished", "DeployFailed", "NgdsSendExhausted", "NgdsBacklog", "SecretExpiringSoon", "HomepageLinksBroken", "PublishStuck", "AlertingTest"],
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

The plugin is `@sap-tutorials/cds-alert-notification` v1.0.0, published **privately
to the org's GitHub Packages** npm registry and consumed by version:

```
"@sap-tutorials/cds-alert-notification": "^1.0.0"
```

Because the `@sap-tutorials` scope is private, installs need a scope→registry
mapping and a token with `read:packages`. The repo's root `.npmrc` provides the
mapping and reads the token from the environment:

```ini
@sap-tutorials:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

- **CI:** the four `npm ci` jobs (`unit`, `check`/`cds-build-staging-check`,
  `check-cp-list`/`srv-qa-cp-list-check`, `validate`) mint a token via the repo's
  existing GitHub App (`actions/create-github-app-token`, gated on
  `vars.USE_GITHUB_APP`) and export it as `NODE_AUTH_TOKEN`, falling back to a
  `PACKAGES_READ_TOKEN` secret. Each job also declares `permissions: packages: read`.
- **Local dev / CF deploy:** set `NODE_AUTH_TOKEN` to a token with `read:packages`
  on the `sap-tutorials` org before `npm install`.

## Master toggle (DB-backed, admin-editable)

- **`ChatSettings.alertsEnabled`** (Boolean, default `false`) — the master
  switch for the helper. Resolved via `srv/lib/runtime-config/alert-settings.js`
  (5 s cache; fail-safe default `false`). This is a **DB column, not an env
  var** — per project convention, operational toggles live in the DB and are
  edited live in the admin UI (`/admin-ui/#joule`, the Joule/ChatSettings page)
  with no restart. There is deliberately **no `ALERTS_ENABLED` env fallback**:
  an env var could silently shadow a fresh admin write until the next restart.

## Operator post-merge checklist

These steps cannot be performed from a PR and must be completed after the MTA
is deployed.

**1. Confirm the GitHub App (or `PACKAGES_READ_TOKEN`) can read GitHub Packages.**
The four CI `npm ci` jobs authenticate to `@sap-tutorials`'s private GitHub
Packages registry via the App token (`vars.USE_GITHUB_APP == 'true'` +
`TUTORIALS_APP_ID`/`TUTORIALS_APP_PRIVATE_KEY`) or the `PACKAGES_READ_TOKEN`
fallback secret. Verify: (a) the App installation on `sap-tutorials` grants
**packages:read** and covers the `cds-alert-notification` repo, OR (b)
`PACKAGES_READ_TOKEN` exists with `read:packages`. Also confirm the CF deploy
pipeline exports a `NODE_AUTH_TOKEN` with the same scope before its `npm install`.
If neither is in place, `npm ci`/`npm install` fails to fetch the plugin.

**2. Publish the plugin to GitHub Packages.**
The plugin must be published before this consumer can install v1.0.0. On the
`sap-tutorials/cds-alert-notification` repo, cut a `v1.0.0` GitHub Release — its
`publish.yml` workflow publishes to GitHub Packages (private). Confirm the
package appears under the org's Packages tab before deploying tutorials-ims.

**3. Regenerate `package-lock.json`.**
`package.json` now references `@sap-tutorials/cds-alert-notification` by version,
but the committed lockfile predates that change (the authoring workstation could
not reach the private registry to resolve it). In an environment with a
`read:packages` `NODE_AUTH_TOKEN` for the `sap-tutorials` org, run `npm install`
to add the resolved entry and commit the updated `package-lock.json`. Until then,
`npm ci` jobs fail on the package.json/lockfile mismatch.

**4. Deploy the MTA (v1.10.0).**
`.deploy/mta.yaml` declares `tutorials-alert-notification` as a managed
`alert-notification` service (plan `standard`). The `mbt build` + `cf deploy`
run provisions the instance and binds it to `tutorials-srv`. No manual `cf
create-service` is needed.

**5. Bind the email action to the `devrel-oncall` distribution list.**
The MTA creates the ANS **instance** but does NOT configure email routing —
that requires a post-deploy step in the ANS cockpit (or via the plugin's
generated `provision.sh`). Open the ANS cockpit for the `tutorial-system`
subaccount, locate the `tutorials-alert-notification` instance, and create an
email ACTION pointing to the real `devrel-oncall` distribution-list address.
Wire it to the `devrel-oncall` CONDITION (minSeverity ERROR). Without this step
the instance is bound but no emails are sent.

> **Every `eventType` needs its own cockpit condition + subscription.** Delivery
> is filtered per-`eventType` in ANS (the plugin only POSTs to the producer
> API). A working `AlertingTest` email does NOT imply the other eventTypes are
> wired — that was the 2026-08-12 gap where only the test path delivered. When
> you add a new `eventType` in `cds.requires.alerts.eventTypes`,
> `cds build` regenerates `gen/alerts/ans-*.json`, but you must also create the
> matching condition + subscription in the cockpit or that alert stays silent.
>
> **The #1718 additions (`RebuildPipelineFailed` ERROR, `SecretExpiringSoon`
> ERROR/WARNING, `HomepageLinksBroken` WARNING, `PublishStuck` WARNING) each need
> a cockpit condition + subscription before they deliver.** Route the ERROR-tier
> ones (`RebuildPipelineFailed`, `SecretExpiringSoon` when critical) to
> `devrel-oncall`; the WARNING-tier ones to `devrel-deploys`. No new managed
> service or MTA change is required — they ride the existing
> `tutorials-alert-notification` instance.

**6. Enable alerting (admin UI — no restart).**

Toggle `ChatSettings.alertsEnabled` to `true` in the admin UI at
`/admin-ui/#joule` (the Joule/ChatSettings settings page). The resolver picks it
up within ~5 s — no `cf set-env`, no restart. (Equivalently, a direct
`PATCH /admin/ChatSettings(<ID>)` with `{ "alertsEnabled": true }`.)

**7. Live-verify one alert end-to-end.**
Trigger a known failure (e.g. a publish-reject via the admin UI with a
deliberately bad slug, or force a scheduled job error in DEV) and confirm the
email arrives at the `devrel-oncall` address. This is the **one path not proven
by any automated test** — the unit tests assert the helper contract and envelope
shapes in memory, but `cds.outboxed()` posting to a real ANS endpoint has not
been exercised against a live CAP runtime. This live-verify is **mandatory**
before declaring the integration done.

**8. Confirm Node runtime floor.**
`package.json` now declares `"engines": { "node": ">=22.12" }` (the plugin's
requirement). Verify the CF buildpack runtime satisfies this before deploying
to PROD. The CI pipeline already runs Node 22; the CF Node.js buildpack default
should be ≥22.12 — confirm with `cf env tutorials-srv | grep VCAP_APPLICATION`
after deploy and check the buildpack version log.

## Surfaces

- CF logs — `cds.log('alerting')` warn lines on any raise failure (e.g. ANS
  unreachable, or `ChatSettings.alertsEnabled` off).
- ANS cockpit — alert history under the `tutorials-alert-notification`
  instance.
- No admin-UI tile in v1 — the metrics module's existing `/admin-ui/#metrics`
  is unchanged; alerting is a push channel only.

## References

- Spec: [`docs/superpowers/specs/2026-08-03-ans-integration-tutorials-ims/spec.md`](../../superpowers/specs/2026-08-03-ans-integration-tutorials-ims/spec.md) (if present)
- Issue: ANS integration tracking issue (see PR description for link)
