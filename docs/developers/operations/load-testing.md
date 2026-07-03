# Load Testing (k6)

> **Status:** DEV-only for v1. See spec [#804](https://github.com/sap-tutorials/tutorials-ims/issues/804) / [docs/superpowers/specs/2026-07-03-804-load-test-suite-design.md](../../superpowers/specs/2026-07-03-804-load-test-suite-design.md).

Load tests live under `test/load/` and run via [k6](https://k6.io). They are read-only against public endpoints on the deployed DEV app. There is **no PR trigger** — CI runs them weekly (Monday 03:00 UTC) and on manual `workflow_dispatch`.

## Install k6

| OS | Command |
|---|---|
| Windows | `winget install k6.k6` |
| macOS | `brew install k6` |
| Linux | see [k6 docs](https://grafana.com/docs/k6/latest/set-up/install-k6/) |
| Any | `docker run --rm -i grafana/k6:0.51.0 run - < test/load/scenarios/01-smoke.js` |

Version pinned to **0.51.0** in CI. Local versions ≥ 0.51 are fine.

## Run a scenario locally

```bash
# Sanity check (30 s, 1 VU)
npm run loadtest:smoke

# 2-min steady baseline
npm run loadtest:baseline

# 15-min ramp — only run when investigating a regression
npm run loadtest:ramp

# Isolate the tutorial-serve HANA/LRU path
LOAD_MODE=cold npm run loadtest:tutorials
LOAD_MODE=hot  npm run loadtest:tutorials

# Socket.IO handshake churn
npm run loadtest:ws
```

Point at a different environment by setting `LOAD_BASE_URL` (AppRouter URL). `LOAD_SRV_URL` is auto-derived from `LOAD_BASE_URL` by replacing `-tutorials-approuter` with `-tutorials-srv`; override it if your naming differs.

```bash
LOAD_BASE_URL=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com \
  npm run loadtest:smoke
```

## Interpret the summary

Every scenario writes `k6-summary.json` at the end of the run (path overridable via `LOAD_SUMMARY_PATH`). Key fields:

- `metrics.http_req_duration.values["p(95)"]` — overall 95th-percentile latency.
- `metrics["http_req_duration{endpoint:tutorial}"].values["p(95)"]` — per-endpoint p95.
- `metrics.http_req_failed.values.rate` — global error rate (0–1).
- `root_group.checks[]` — pass/fail counts per named check.
- Threshold violations surface in `metrics[...].thresholds` and exit non-zero from k6.

Threshold values are centralised in [`test/load/config.js`](../../../test/load/config.js) — `THRESHOLDS`. Never hardcode ms values in scenario files.

## Threshold philosophy

Provisional ceilings, roughly 3× measured baseline. If runs consistently sit far below the ceiling, tighten it. If runs bump the ceiling, **investigate before relaxing.** A cache-eviction storm at high VU is a real observation, not an excuse to widen the threshold.

## Publish-in-flight guard

The CI workflow hits `GET /content/hashes` twice with 10 s between; if the manifest version changes, it aborts with `SKIP: publish in progress` and does **not** upload an artifact. This prevents a scheduled load run from polluting numbers during a `rebuild-content.yml` publish. Locally, if you know a publish is running, wait.

## Pair with #805 observability

Load runs are most useful when read against the metrics rollups from [#805](../../superpowers/specs/2026-07-02-805-observability-instrumentation-design.md):

```bash
# Before
curl -su "$ADMIN_BASIC_AUTH" $SRV_URL/admin/metrics/live > before.json

# Run
npm run loadtest:tutorials

# After
curl -su "$ADMIN_BASIC_AUTH" $SRV_URL/admin/metrics/live > after.json

# Diff cache stats, HANA acquire latency, publish timings
diff <(jq -S . before.json) <(jq -S . after.json)
```

For weekly CI runs, open `/admin-ui/#metrics` and look at the 03:00–03:30 UTC Monday window in the `MetricSnapshots` chart.

## Adding a new scenario

1. Add a scenario file at `test/load/scenarios/NN-<name>.js`. Copy the smallest existing scenario as a template.
2. Add thresholds to `test/load/config.js` `THRESHOLDS`. Key them on `{scenario:<name>,endpoint:...}` so they don't accidentally match other scenarios.
3. Add a `loadtest:<name>` script to `package.json`.
4. Add a `<name>` option to `.github/workflows/load-test.yml` `scenario` input `choice`.
5. Add a bullet to this runbook.

## Not in scope

- **PROD load testing.** Spec explicitly punts to post-cutover.
- **Authenticated endpoints.** Everything hit is public.
- **Alerting integrations.** The CI workflow failure IS the alert.
- **Historical trend charts.** Pull artifacts from prior workflow runs (90 d retention).
