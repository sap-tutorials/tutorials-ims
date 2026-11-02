# Scheduler readiness gate for blue-green deploys (#2975 Fault A)

**Date:** 2026-11-02
**Issue:** sap-tutorials/tutorials-ims#2975
**Status:** design — awaiting approval

## Intent and why

Every blue-green deploy of `tutorials-ims` can leave the scheduler stalled, requiring a
manual `cf restart-app-instance`. Issue #2975 identified **two combining faults**:

- **Fault B — idle runner.** CAP 10.2's in-memory outbox runner does one boot flush then
  re-arms only off an event-driven chain; when that chain doesn't carry forward after a
  deploy, ready rows sit unconsumed until the undocumented `'1h'` `flushInterval` fallback.
  **Already fixed** by #2975's `cds.flush()` self-heal (merged to main via #2980) — bounds
  drain latency to ≤1 self-heal interval (~10 min).

- **Fault A — no readiness gate (this design).** `tutorials-srv` declares no
  `health-check-type` in `.deploy/mta.yaml`, so CF defaults to `health-check-type: port`.
  An instance is marked healthy the instant its TCP port accepts — which is
  `cds.on('listening')`, **before** `CronService.init()` has wired the scheduler. On a
  blue-green swap CF therefore retires the OLD (blue) instances as soon as green's port is
  up, not when green is actually ready. A `/health` endpoint exists (`srv/server.js:292`)
  but nothing points CF at it, and it asserts nothing about the scheduler.

Closing Fault A stops CF retiring blue before green is wired. Combined with the Fault B
flush (already shipped), post-deploy recovery becomes automatic with no manual restart.

## What "safe to switch" means (the core decision)

Three boot states, in order:

1. **Port open** (`cds.on('listening')`) — today's gate. Too early: scheduler not wired.
2. **Scheduler wired** — `CronService.init()` finished its `schedule().every().as()` loop
   (`srv/cron-service.js:44`); outbox rows exist and `cds.db` is connected.
3. **Scheduler draining** — the processor has actually consumed ≥1 tick since boot.

State 3 is what we'd *love* to gate on, but it is **unreachable synchronously**: the
fastest canary (`metrics-rollup`) is `*/5`, so a freshly-booted green could legitimately
take up to 5 min before it has drained anything — far beyond any CF health-check timeout.
Gating on state 3 would make CF kill every healthy freshly-booted instance. That is a trap
and is explicitly **out of scope**.

**Decision: the readiness gate asserts state 2 (`scheduler wired + DB connected`).** The
state-3 drain guarantee comes from the already-shipped #2975 `cds.flush()` self-heal, not
from the health check. The two compose:

- Gate (Fault A): CF won't retire blue until green is wired + DB-connected.
- Flush (Fault B): green drains within ≤10 min even though the gate can't wait for a drain.

## Goals

- `tutorials-srv` (and `tutorials-srv-qa`, same `srv/` code) expose an HTTP readiness probe
  that returns 200 only once `CronService.init()` completed **and** `cds.db` answers.
- CF's blue-green swap honors that probe via the MBT-supported `health-check-type: http`
  module parameter, so blue is retired only after green is wired.
- A blue-green deploy to DEV recovers the scheduler with **no manual restart** (acceptance).
- Unit-tested (SQLite) and documented in the runbook.

## Non-goals / anti-goals

- **Not** gating on drain (state 3) — see above; would self-sabotage deploys.
- **Not** repurposing the existing `/health` — CAP ships `/health` as its own
  liveness/readiness contract (`{status:'UP'}`); this repo already overrides it. Keep it a
  dumb liveness check; add a *separate* readiness endpoint so no existing `/health` consumer
  or CF liveness check gains a new dependency on the scheduler.
- **Not** using CF's dedicated `readiness-health-check-type` — the CAP docs note it is *not
  yet supported by the CF CLI or MBT*. We use the long-supported `health-check-type: http`
  liveness parameter instead.
- **Not** lowering the undocumented `flushInterval` — out of bounds per the "no undocumented
  `@sap` API" rule; the flush self-heal already covers it.
- **Not** touching the approuter's existing #1678 `-idle` served-content guard — it layers
  on top (approuter content vs. srv scheduler), no conflict.

## Constraints

- `/health/ready` is **public/anonymous** (CF health checks send no auth). Keep it cheap:
  one in-memory boolean read + one `SELECT 1 FROM DUMMY`. No heavier work (DoS surface).
- Must not introduce a `server.js ↔ cron-service.js` import cycle (today there is none).
- Fail-safe on the deploy side: if green never readies, 503 must cause the deploy to fail
  (blue stays serving) rather than swap to a half-booted green. CF bounds this via
  `health-check-invocation-timeout` + the app-start-timeout; a never-ready green aborts the
  blue-green op (the existing `abortFailedBlueGreen` safety net frees the idle apps).

## The how (decided)

### 1. Shared readiness latch — `srv/lib/scheduler-ready.js` (new)

A tiny module with no `@sap/cds` dependency, importable by both `server.js` and
`cron-service.js` without a cycle:

```js
let _ready = false;
export function markSchedulerReady() { _ready = true; }
export function isSchedulerReady() { return _ready; }
export function _resetForTests() { _ready = false; } // test-only
```

### 2. Flip it at end of `CronService.init()` — `srv/cron-service.js`

After the `schedule().every().as()` loop and the self-heal arming, immediately before
`await super.init()` (line 106): call `markSchedulerReady()`. This is state 2 — schedules
registered, self-heal armed. The deferred boot reap/reconcile (`setImmediate`) do **not**
gate readiness (they're recovery, not a serving precondition).

### 3. `/health/ready` endpoint — `srv/server.js` (next to `/health`, ~line 294)

```js
app.get('/health/ready', async (req, res) => {
  const schedulerArmed = isSchedulerReady();
  let db = 'connected';
  try { await cds.db?.run('SELECT 1 FROM DUMMY'); }
  catch { db = 'error'; }
  const ready = schedulerArmed && db === 'connected';
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not-ready',
    scheduler: schedulerArmed ? 'armed' : 'pending',
    db,
    timestamp: new Date().toISOString(),
  });
});
```

`/health` (line 292) is left unchanged as the dumb liveness check.

**Auth ordering (confirmed):** `/health` is registered inside `cds.on('bootstrap')` (server.js:233)
and `app.use(basicAuthMiddleware)` is at server.js:319 — so `/health/ready` placed adjacent to
`/health` sits **before** auth and is reachable anonymously by CF's health checker. CF probes the
container directly (approuter / `xs-app.json` routing irrelevant). `tutorials-srv-qa` runs the same
`srv/` code with no base-path prefix, so the **single** `health-check-http-endpoint: /health/ready`
value is correct for both modules.

> **Local note.** `CronService` only arms (and thus flips ready) on CF
> (`SCHEDULER_HEALTHCHECK_ENABLED`/CF detection); but `markSchedulerReady()` is called
> unconditionally at the end of `init()`, so `/health/ready` is accurate locally too
> (init() runs under `cds watch`). The gate only *matters* on CF, where the MTA points CF at
> it. If a future refactor makes `init()` skip on some path, revisit this.

### 4. MTA readiness gate — BOTH `.deploy/mta.yaml` AND root `mta.yaml`

**Builder-check finding (confirmed):** the two mta.yaml files are **independent hand-maintained
copies**, both live on different deploy paths:
- `.deploy/mta.yaml` (604 lines) — the **local/workstation** deploy source (`cd .deploy && mbt build`).
- root `mta.yaml` (471 lines) — what **CI builds** (`.github/workflows/deploy.yml:264` `mbt build -e deploy/<env>.mtaext`).

Both carry `tutorials-srv` and `tutorials-srv-qa`. **Edit both and keep them in sync** (same
discipline as the repo's `srv-qa cp list audit` rule). Add to the `tutorials-srv` **and**
`tutorials-srv-qa` module `parameters:` blocks in **each** file:

```yaml
      health-check-type: http
      health-check-http-endpoint: /health/ready
      health-check-invocation-timeout: 10
      timeout: 180
```

- `health-check-invocation-timeout: 10` (s) — per-probe budget; room for the `SELECT 1` without
  letting a wedged instance linger.
- **`timeout: 180` (decided) — explicit app-start-timeout.** `CronService.init()` runs a 32-job
  `.schedule().every().as()` UPSERT loop against a **cold HANA connection** before
  `markSchedulerReady()`. The default CF start timeout (~60s) risks fail-starting a *healthy*
  green if that loop + first DB connect runs long — reintroducing the "self-sabotage" the state-3
  discussion warns about, now at state 2. 180s gives comfortable headroom. The DEV validation
  (below) measures real boot-to-ready; tune down only with data.

**Exclusions (confirmed footgun):**
- `mta-mcp.yaml`'s `tutorials-srv-mcp` (path `gen/srv-mcp`) runs `srv-mcp/` code which has **no
  `CronService`** (grep: zero `CronService`/`registerJobs`/`markSchedulerReady` refs). Gating it on
  `/health/ready` would 503 **forever** → every MCP-MTA deploy fails to start / aborts. **Do NOT**
  add the health-check keys to `mta-mcp.yaml`. The "grep and match" instruction scopes to the two
  real `tutorials-srv`/`-qa` modules only.

Env-agnostic → no `deploy/*.mtaext` override needed (confirmed: no existing `health-check` key in
any mtaext).

### 5. Tests (SQLite unit) — `test/unit/srv/lib/scheduler-ready.test.js` (new)

- latch defaults to `false`; `markSchedulerReady()` → `true`; `_resetForTests()` → `false`.
- (if an existing server-level harness exists) `/health/ready` returns 503 when
  `isSchedulerReady()` is false, 200 when true + db ok, 503 when the `SELECT 1` throws.
  If no cheap server harness exists, unit-test the latch + a extracted pure
  `computeReadiness({schedulerArmed, db})` helper rather than standing up Express.

### 6. Runbook — `docs/developers/operations/scheduler-troubleshooting.md`

Convert the "Readiness note (open follow-up)" paragraph (added in the #2975 docs PR #2984)
into the shipped mechanism: a short "Readiness gate (#2975 Fault A)" subsection describing
the three boot states, why the gate asserts state 2 not state 3, the endpoint contract, the
MTA keys, and how it composes with the flush self-heal.

## What's left to the builder

- Exact insertion offsets (line numbers drift); place `/health/ready` adjacent to `/health`.
- Whether a cheap Express/supertest harness already exists for endpoint-level tests, or to
  fall back to the extracted `computeReadiness` pure-function test.
- Confirm `health-check-invocation-timeout` and `timeout` are accepted by the installed MBT
  version; if the schema rejects either, drop just that line (the two required keys are
  `health-check-type` + `health-check-http-endpoint`).
- Verify the exact `JobLastRun` entity/table name before trusting the validation SQL.

## Operational validation (DEV, after merge to DEV)

**Swap flow (confirmed):** this repo's blue-green is **paused** — green comes up, the deploy
PAUSES ("green apps up — PAUSED", `scripts/deploy-mta.cjs`), the operator verifies, then resumes
with `cf deploy -i <op> -a resume`. The `health-check-type: http` gate makes CF refuse to mark
green **"started"** (→ the pause is reachable) until `/health/ready` returns 200, i.e. the gate
fires **before** the pause. So "no manual restart" in the acceptance below means **no
`cf restart-app-instance` after the resume** — the resume itself is the normal, expected step, not
a failure.

1. `cf target` → confirm **dev** space before anything.
2. Confirm the gate took effect on the running app:
   `cf curl /v3/apps/$(cf app tutorials-srv --guid)/processes` → `health_check.type: http`,
   `.data.health_check.data.endpoint: /health/ready`, and note the start-timeout.
   **Measure boot-to-ready** here (app `since` → first `/health/ready` 200) to confirm the
   `timeout: 180` headroom is right; tune down only with data.
3. Paused blue-green deploy to DEV (`npm run deploy -- --env dev --strategy blue-green`, or the
   deploy-watcher). At the pause, verify green's `/health/ready` is 200, then `-a resume`.
   **No `cf restart-app-instance` afterward** — that's the whole test.
4. Measure canary staleness with the **DB clock** (JS `Date` has a ~7h tz offset on these
   instances and will mislead):
   ```sql
   SELECT job_name,
          SECONDS_BETWEEN(last_success_at, CURRENT_UTCTIMESTAMP) AS stale_s
   FROM "<JobLastRun table>" WHERE job_name IN ('metrics-rollup','kg-ondemand-drain');
   ```
   via `cds bind --exec -- …` against DEV HANA (read-only). (Verify the exact entity/table name
   first — e.g. via `cds repl` — before trusting the SQL.)
5. **Pass:** `metrics-rollup` (`*/5`) holds its 5-min cadence across **≥2 cycles** post-swap with no
   manual restart; `stale_s` never exceeds ~5 min + grace. Then promote to PROD (same paused flow).

## Acceptance (from #2975)

- [x] Fault B `cds.flush()` fix (prior work, merged #2980).
- [ ] Fault A readiness gate: blue-green deploy to DEV self-recovers, no manual restart.
- [ ] Automated test (unit, SQLite) for the readiness signal.
- [ ] Runbook documents the readiness gate alongside the flush/reaper/re-seed recovery.
