# Load-test suite — k6-based CI-gated performance harness for public endpoints

**Issue:** [#804](https://github.com/sap-tutorials/tutorials-ims/issues/804)
**Date:** 2026-07-03
**Author:** Tom Jung (design captured by Claude — issue body was empty, defaults picked and documented; awaiting review)
**Status:** Ready for user review

## Problem

The tutorial-system replaces AEM at end-of-July 2026. AEM was CDN-fronted with content-in-cache — response-time behaviour under real traffic was set by Akamai and never really touched the origin. The CAP-based replacement serves tutorial HTML dynamically from HANA BLOB decompression through a bounded LRU (`ContentCache`, 50 MB) with the AppRouter in front — a completely different performance profile. We do not know:

1. **What p95 `/tutorials/{slug}` looks like under concurrent load** — cold cache vs warm cache, with the LRU actively evicting.
2. **When the HANA connection pool starts queueing acquisitions** — the pool has bounded capacity and long-running writes (publish commit, embedding jobs, KG rebuild) contend with read traffic. The observability spec (#805) instruments *acquire-latency*; we have no way to *drive* the pool to see when it degrades.
3. **How the `/api/advocates` public JSON list + `/api/advocates/:slug/photo` WebP endpoint behave** under thundering-herd (they're on the developer-advocates page which we expect to be linked from external SAP channels).
4. **Whether `/build/catalog` (unauthenticated, expensive projection) survives the traffic** a homepage tile refresh could produce.

There is currently **no automated performance test of any kind**. `test:smoke` verifies endpoints answer 200 with correct content-type at 1 request. Nothing verifies they answer within N ms at K concurrent virtual users. This is the last major test-category gap before PROD cutover.

## Scope

**In scope**

- New top-level directory `test/load/` with k6 test scripts organised by scenario.
- Five k6 scenarios: `smoke`, `public-baseline`, `public-ramp`, `tutorial-serve`, `websocket-handshake`.
- Shared config module (`test/load/config.js`) — base URL, threshold table, tag conventions.
- Shared helpers: dynamic slug list from `/build/catalog` (no hardcoded slugs), threshold-tagged HTTP wrapper.
- Package-json `loadtest:*` scripts (thin passthroughs to `k6 run`).
- `docs/developers/operations/load-testing.md` runbook — install, run locally, interpret output, tie to #805 observability.
- `.github/workflows/load-test.yml` — weekly cron (Mon 03:00 UTC) + manual `workflow_dispatch`, targets DEV srv, uploads k6 JSON summary as artifact.
- Threshold table pinning p95 / error-rate ceilings per endpoint class. Failing threshold = failing workflow.
- CLAUDE.md gotcha entry so future agents know load tests exist, are k6-driven, and do NOT run in every PR.

**Out of scope (explicit)**

- **Node-based tools (autocannon / artillery)** — considered and rejected below. k6 wins on threshold-driven CI gating.
- **PR-triggered load runs.** Weekly + manual dispatch only. Load traffic against DEV is not free (CF vCPU, HANA vCPU); PR-triggered would burn quota with no incident-response value.
- **PROD load testing.** DEV-only for v1. When PROD spins up post-cutover, a separate spec will address PROD-safe patterns (rate-limited, off-hours, subset endpoints).
- **Authenticated `/admin/*` endpoints.** They aren't the concern for a public tutorial site. Admin scope has O(10) simultaneous users, ever.
- **Alerting thresholds separate from CI thresholds.** The CI gate is the alert. If p95 regresses past the threshold, the workflow fails and posts a summary — no PagerDuty, no Slack webhook, no incident tooling.
- **Historical trend chart.** Artifact JSON is retained by GitHub's 90-day default; anyone who wants a chart can pull the artifacts. A "performance dashboard" is v2.
- **Load-driving from multiple regions.** All load originates from `ubuntu-latest` runners in the default GitHub region.
- **Stress / soak beyond the ramp scenario.** No 1-hour soaks, no chaos-monkey. The ramp (0→100 VU, 5-min ramp + 10-min hold) is the ceiling.

## Tool choice — k6 over artillery / autocannon

Three candidates were considered against the four requirements (threshold-driven CI gate, works against a deployed CF app, handles WebSocket, non-Node runtime so it doesn't share test-runner surface with Vitest):

| Requirement | k6 | artillery | autocannon |
|---|---|---|---|
| Threshold-driven CI pass/fail | Native (`thresholds` config, non-zero exit) | Plugin, awkward | Not built-in |
| Scenario runner (stages, executors) | Native | Native | None (single URL hammering) |
| WebSocket support | Native (`ws` module) | Native | HTTP only |
| Runtime independence from Node | Go binary; no `node_modules` interference | Node | Node |
| Auth flow (bearer, cookie carry) | Native | Native | Manual |
| JSON summary for CI artifacts | `--summary-export=path` | Plugin | JSON output but flat |
| Docker image maintained officially | `grafana/k6:latest` | Third-party | Third-party |

**Decision: k6.** Reasons:

1. Threshold-driven exit is the whole reason to add a suite. k6 makes `--fail-if-p95-over` idiomatic; artillery needs post-processing; autocannon needs a hand-rolled parser.
2. Runtime independence matters. Vitest, Playwright, Lighthouse, and Hugo all live in Node; adding another Node-based load runner risks version-lock skirmishes (autocannon has `undici` transitive-dep issues on Node 24). k6 is a Go binary — separate concern, separate install path.
3. The k6 test format (ES modules with `default export function () {...}`) is close enough to Vitest that Node-fluent contributors read it without new syntax.

**Cost of k6:** local install (`winget install k6.k6` on Windows, `brew install k6` on macOS, `docker run grafana/k6` everywhere). CI uses the Docker image — no per-run install cost. Documented in the runbook.

## Scenarios and thresholds

Each scenario is a separate `.js` file so `k6 run` can execute one in isolation. `test/load/config.js` centralises threshold values so a bump lives in one place.

### 1. `smoke` — 1 VU × 30 s

Sanity check. Hits every endpoint the baseline scenario covers, once. Verifies the harness is wired correctly (env vars, slug fetch, WebSocket handshake). Fast enough to run on every push if someone wants to gate PRs — but not wired that way by default.

**Threshold:** all requests 2xx/3xx, no execution errors.

### 2. `public-baseline` — 10 VU × 2 min

Steady load across the five public endpoints, weighted by expected real-world hit rate:

| Endpoint | Weight | p95 threshold | Error-rate threshold |
|---|---|---|---|
| `GET /build/catalog` | 20% | 500 ms | < 1% |
| `GET /build/navigator` | 10% | 500 ms | < 1% |
| `GET /tutorials/{slug}` (random from catalog) | 50% | 300 ms | < 1% |
| `GET /api/advocates` | 15% | 200 ms | < 0.5% |
| `GET /api/advocates/{slug}/photo` | 5% | 300 ms | < 0.5% |

Weight rationale: `/tutorials/{slug}` is the hot path (that's the reason for the platform); `/build/catalog` is called on every homepage load; `/api/advocates` is a public JSON list with a 60 s cache + SWR, so occasional hits.

**Rationale for the numbers.** These are provisional ceilings, set at "roughly 3× measured baseline" so a legitimate regression trips the gate but normal variance doesn't. The first weekly run establishes the actual baseline; if runs consistently sit far below the threshold, the runbook says to tighten it. If runs bump the ceiling, the response is to investigate first, relax the ceiling second. Baselines from a warm DEV env with no publish in flight, one CF instance idle, LRU cold-started 30 s before run.

### 3. `public-ramp` — 0 → 100 VU over 5 min, hold 10 min

Same endpoint mix as `public-baseline`. Purpose: find where p95 degrades. Threshold is *softer* — p95 must not exceed 2× the baseline value at any point during the hold.

**Failure isn't necessarily a bug.** A cold LRU eviction storm at VU=100 is a legitimate observation about tuning. The run's job is to *record* the degradation; the on-call human decides whether to widen `ContentCache` capacity, add a CF instance, or accept it.

### 4. `tutorial-serve` — 50 VU × 3 min, hammering `/tutorials/{slug}`

Isolates the HANA BLOB decompress + LRU cache path. Two sub-modes:

- **Cache-hot:** picks 10 fixed slugs at test start, hammers only those. p95 threshold: 150 ms (all served from LRU after the first ~50 requests).
- **Cache-cold:** picks a fresh random slug on every request. Threshold: p95 < 500 ms — this drives HANA decompression on every miss and exercises the LRU eviction path.

The scenario file switches modes via a `--env MODE=hot|cold` CLI arg. Default is `cold` (the interesting one for regressions).

### 5. `websocket-handshake` — 20 VU, 30 s each, connecting and disconnecting

Opens a Socket.IO connection to `/ws/event-stream`, waits for the `connect` ack, disconnects. No message traffic (that's `EventStreamService`'s job to test at the CAP layer). Purpose: catch handshake-throughput regressions after auth-middleware or approuter changes.

**Threshold:** handshake time p95 < 1 s, connection error rate < 2%. Higher error tolerance because approuter has a documented 30 s connection ceiling on the free CF plan.

## Layout

```
test/load/
  README.md                            # quick start — install, run smoke, interpret output
  config.js                            # base URL, threshold table, tag conventions
  lib/
    slugs.js                           # fetch /build/catalog once at setup, share slug list
    http.js                            # thresholds-tagged HTTP helper
    checks.js                          # shared response validators (status + content-type)
  scenarios/
    01-smoke.js
    02-public-baseline.js
    03-public-ramp.js
    04-tutorial-serve.js
    05-websocket-handshake.js
docs/developers/operations/load-testing.md
.github/workflows/load-test.yml
```

Package.json adds:

```json
"scripts": {
  "loadtest:smoke": "k6 run test/load/scenarios/01-smoke.js",
  "loadtest:baseline": "k6 run test/load/scenarios/02-public-baseline.js",
  "loadtest:ramp": "k6 run test/load/scenarios/03-public-ramp.js",
  "loadtest:tutorials": "k6 run test/load/scenarios/04-tutorial-serve.js",
  "loadtest:ws": "k6 run test/load/scenarios/05-websocket-handshake.js"
}
```

No top-level `loadtest` script that runs them all — the ramp scenario is 15 min alone. Scripts are stepping-stones, not a "run everything" macro.

## Environment inputs

k6 reads these env vars (documented in `config.js` with defaults):

| Var | Default | Purpose |
|---|---|---|
| `LOAD_BASE_URL` | `https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com` | AppRouter URL (routes to srv for the tests we care about). |
| `LOAD_SRV_URL` | *(derived from `LOAD_BASE_URL` if unset)* | Direct srv URL for endpoints that skip AppRouter — currently only `/build/*`. |
| `LOAD_VUS` | *(scenario default)* | Overrides VU count when experimenting locally. |
| `LOAD_DURATION` | *(scenario default)* | Overrides duration. |
| `LOAD_MODE` | `cold` | Only read by `tutorial-serve` scenario. |
| `LOAD_SUMMARY_PATH` | `k6-summary.json` | Where to write the JSON summary artifact. |

No secrets required — all endpoints hit are public (unauthenticated). This is a deliberate constraint: if we start hitting `/admin/*`, we need to manage bearer-token rotation, and that's a separate spec.

## CI workflow

`.github/workflows/load-test.yml`:

- **Triggers:** `schedule: '0 3 * * 1'` (Mon 03:00 UTC, low-traffic window) + `workflow_dispatch` with a `scenario` input (`smoke|baseline|ramp|tutorials|ws|all-except-ramp`).
- **Runner:** `ubuntu-latest`.
- **Image:** `grafana/k6:0.51.0` (pinned; upgrade requires a spec bump).
- **Step outline:**
  1. Checkout.
  2. Resolve `LOAD_BASE_URL` from repository variable `LOAD_BASE_URL` (default: DEV srv).
  3. Run `docker run --rm -v $PWD:/work -w /work -e LOAD_BASE_URL grafana/k6:0.51.0 run test/load/scenarios/${scenario}.js --summary-export=k6-summary.json`.
  4. Upload `k6-summary.json` as workflow artifact (retention 90 d — GitHub default).
  5. **On threshold-fail** (k6 exits non-zero): step continues, artifact still uploads, then a final "fail loudly" step re-echoes the summary and `exit 1`. Keeps the artifact even when the workflow fails.
- **Concurrency:** `cancel-in-progress: false, group: load-test` — a manual dispatch during a scheduled run waits, not overrides. Two concurrent load runs against DEV would produce meaningless numbers for both.
- **No PR trigger.** Explicit.

## Interaction with observability (#805)

The observability spec landed `MetricSnapshots` rollups every 5 min and a `/admin/metrics/live` snapshot endpoint. The load-testing runbook documents the pairing:

1. `curl /admin/metrics/live` → save `before.json`.
2. `npm run loadtest:tutorials` locally, or dispatch the workflow.
3. `curl /admin/metrics/live` → save `after.json`.
4. Diff `content.cache.hit`, `content.cache.miss`, `content.cache.evict`, `db.acquire.ms` p95, `publish.commit.ms` p95.

For weekly CI runs, the runbook says "check the `MetricSnapshots` chart in `/admin-ui/#metrics` for the window covering 03:00–03:30 UTC Monday." No new infrastructure — reuse #805's UI.

## Data hygiene

All scenarios are **read-only** against public endpoints. No `__TEST__` prefix needed. No cleanup. No write-safety guard.

`tutorial-serve` scenario in `cold` mode selects slugs at random from the live `/build/catalog`. If a tutorial gets renamed between test runs, the request 404s — counted as an error against the error-rate threshold. Acceptable — 404s during a rename are a real observation, not a test artifact.

## Failure modes and out-of-band guardrails

1. **Load-run coincides with a publish.** `rebuild-content.yml` uploads to HANA and thrashes the LRU. If a scheduled load run happens mid-publish, p95 will spike. Mitigation: the load-test workflow starts by hitting `GET /content/hashes` twice with 10 s between; if the manifest version changes, it aborts with a `SKIP: publish in progress` message and does *not* upload an artifact. Documented in the runbook.
2. **DEV space rotates URL.** Handled — `LOAD_BASE_URL` is a repository variable, one edit rotates it.
3. **k6 image bit-rot.** Pinned tag (`0.51.0`). Upgrade is a separate PR with a manual smoke run.
4. **Contributor runs locally without k6 installed.** `npm run loadtest:smoke` errors with the raw shell "command not found." The `test/load/README.md` opens with the install line for each OS.

## Rollout

Single PR, no phases. The suite is inert until someone runs it — nothing production-facing changes. Suggested merge order:

1. Land this spec.
2. Implementation PR adds `test/load/`, package-json scripts, docs, and the workflow.
3. First scheduled run happens the next Monday; the CLAUDE.md gotcha is updated with a link to the artifact so future agents can see what "normal" looks like.

## Open questions for the reviewer

Two knobs I picked defaults for but that Tom might want to tune:

- **Threshold values in section 2.** I picked "3× measured baseline" as the ceiling philosophy; the concrete numbers (500 ms, 300 ms, 200 ms) are guesses. If Tom has p95 memories from the AEM stack or the Java IMS, we should replace the guesses with those.
- **Weekly cadence.** Monday 03:00 UTC. Nightly would give a tighter regression signal, but at 5×–7× the CF/HANA vCPU cost per week. I lean toward starting weekly and moving to nightly if we see regression patterns.

Anything else the reviewer flags, I'll revise before writing the plan.
