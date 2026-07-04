# #958 — Migrate the scheduler chassis to the CAP 10 Scheduling API

**Status:** Design approved 2026-07-04
**Issue:** [sap-tutorials/tutorials-ims#958](https://github.com/sap-tutorials/tutorials-ims/issues/958)
**Predecessor:** #957 (CAP 10 runtime upgrade, adopted; scheduler adoption intentionally deferred)
**Related spec:** `docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md` (admin manual-trigger chassis)

## Goal

Replace the `node-cron`-driven engine inside `srv/jobs/scheduler.js` with CAP 10's native Scheduling API (`srv.schedule('event', payload).every(cron).as(singleton)`), while preserving every observable behavior of the current chassis:

- All 32 registered jobs continue to fire on their existing cron expressions.
- Distributed locking still prevents multi-instance CF races (now via CAP 10's `.as(name)` status-column singleton locking instead of our `JobLocks` entity).
- `AdminService.JobControls.listJobs` still returns rows with `nextRunIso`.
- `AdminService.JobControls.runJob(jobName)` still triggers a manual run, still emits the `SecurityEvent` audit trail (`started` + completion).
- `PipelineLog` start/end rows and `JobLastRun` UPSERT continue to back the admin Job Log tile and Cron health tile.
- `test/hybrid/admin-run-job.test.js` passes green.

Non-goals:
- Reworking any individual job's logic.
- Exposing `scheduleOverride` to admins (a separate #756 follow-up).
- Adopting CAP outbox retry semantics (jobs keep today's swallow-and-log-error posture).

## Migration posture (approved)

**Thin adapter — keep the `JOB_REGISTRY` + `runWithLock` chassis, swap the engine only.** The 32 `registerJob({...})` call sites in `registerJobs()` do not change. The public shape of `registerJob`, `runJobByName`, `preSeedJobLastRun`, `formatJobSummary`, and both contributor-notification cycle helpers is preserved. Admin UI code and all admin action handlers in `srv/admin-service.js` are unchanged. `srv/lib/cron-firings.js` is unchanged — `cron-parser` continues to power the "Next 3 runs" tile.

Two things are deleted outright:
- `srv/jobs/job-lock.js` (and the DB-backed `JobLocks` entity in `db/schema.cds`) — CAP 10's `.as(name)` status-column locking replaces it.
- `node-cron` from `dependencies` — no longer used anywhere.

## Architecture

A new internal service `CronService` acts as the scheduling bus. It is defined in `srv/cron-service.cds` with **no** `@path`, no `@requires`, and no protocol annotation. It is never exposed on any adapter — it exists purely as a target for `srv.schedule(...)` calls and their matching `srv.on(...)` handlers. Because it has no protocol annotation, the CAP 10 Java-default protocol change (`odata-v2`, `odata-v4`, `odata-x4`) does not apply (Node.js runtime, no `@path`).

**Files added:**
- `srv/cron-service.cds`
- `srv/cron-service.js`

**Files touched:**
- `srv/jobs/scheduler.js` (engine swap: remove `node-cron` + `JobLocks` wiring)
- `server.js` (remove the `served` hook block that calls `registerJobs()`)
- `db/schema.cds` (remove the `JobLocks` entity)
- `package.json` (drop `node-cron` from `dependencies`)

**Files unchanged:**
- `srv/admin-service.js` (all 4 admin actions that call `runJobByName` keep working — that path bypasses cron)
- `srv/lib/cron-firings.js` (`cron-parser` stays)
- All 32 job modules under `srv/jobs/`
- All admin UI code (`app/admin/*`, `app/admin-shell/*`)
- `srv/lib/pipeline-log.js`

**Files removed:**
- `srv/jobs/job-lock.js`

## Component design

### `srv/cron-service.cds`

```cds
namespace com.sap.developers.ims;

// Internal scheduling bus. NOT exposed on any protocol — no @path, no
// @requires, no @odata/@rest annotations. Only used as a target for
// srv.schedule(...).every(...).as(...) calls originating from
// srv/jobs/scheduler.js. All 32 registered jobs land here as
// events named 'cron.<jobName>'.
service CronService {}
```

### `srv/cron-service.js`

```js
import cds from '@sap/cds';
import { _getJobRegistry, registerJobs, preSeedJobLastRun, runJobByName } from './jobs/scheduler.js';

export default class CronService extends cds.ApplicationService {
  async init() {
    // Populate JOB_REGISTRY (32 entries) and seed JobLastRun rows.
    // Owned entirely by CronService now — the previous 'served' hook in
    // server.js that called registerJobs() is removed.
    registerJobs();
    await preSeedJobLastRun();

    // Wire one handler + one schedule() call per registered job.
    for (const job of _getJobRegistry().values()) {
      const eventName = `cron.${job.jobName}`;
      this.on(eventName, () => runJobByName(job.jobName));
      await this.schedule(eventName, {})
        .every(job.schedule)
        .as(job.jobName);
    }
    await super.init();
  }
}
```

### `srv/jobs/scheduler.js` (surgical changes)

Three edits:

1. **Delete imports:** `import cron from 'node-cron';` and `import { acquireLock, releaseLock } from './job-lock.js';`.
2. **Delete cron scheduling in `registerJob`:** the line `cron.schedule(schedule, () => runJobByName(jobName));` is removed. `registerJob` becomes registry-only:
    ```js
    export function registerJob({ jobName, schedule, ttlMs, description, fn }) {
      if (JOB_REGISTRY.has(jobName)) {
        throw new Error(`Duplicate jobName: ${jobName}`);
      }
      JOB_REGISTRY.set(jobName, { jobName, schedule, ttlMs, description, fn });
    }
    ```
3. **Delete lock acquire/release in `runWithLock`:** the `acquireLock` block at the top and `releaseLock` in the `finally` are removed. The `if (!acquired) return { skipped: true, reason: 'lock-held' }` branch — and the `outcome:'lockheld'` audit event that goes with it — are also removed. CAP 10's `.as(name)` singleton semantics mean the handler cannot run concurrently across CF instances, so `lock-held` is structurally impossible. All other `runWithLock` responsibilities are preserved verbatim: `logPipelineStart` / `logPipelineEnd`, `recordJobLastRun` in the `finally`, and `emitJobAuditSafely` on manual triggers for `success` / `error` outcomes.

The header docstring is updated to describe the new engine.

### `server.js`

The `served` hook block that calls `registerJobs()` is deleted:

```diff
- cds.on('served', async () => {
-   const { registerJobs } = await import('./jobs/scheduler.js');
-   registerJobs();
- });
```

`CronService.init()` owns the scheduler lifecycle now.

## Data flow

### Boot

```
CAP loads services
  → CronService.init()
    - registerJobs()                            // populates JOB_REGISTRY (32 entries)
    - preSeedJobLastRun()                       // JobLastRun row per job
    - for each job in JOB_REGISTRY:
        this.on('cron.<name>', () => runJobByName(name))
        this.schedule('cron.<name>', {}).every(job.schedule).as(job.jobName)
    - super.init()
```

### Scheduled tick

```
CAP outbox picks message 'cron.<name>' with status=pending
  → sets status=processing (status-column singleton lock, .as() name = jobName)
  → invokes CronService's 'cron.<name>' handler
    → runJobByName(name)
      → runWithLock(name, ttlMs, fn, {})
        - logPipelineStart('SCHEDULED_JOB', 'system', {jobName}) → logId
        - try  { result = await fn(logId); logPipelineEnd(logId, 'SUCCESS', summary) }
        - catch { outcome='error'; errorMessage=err.message; logPipelineEnd(logId, 'FAILED', ...) }
        - finally { recordJobLastRun(name, outcome, errorMessage) }
    - handler returns (success — no error thrown out)
  → outbox deletes message
```

Errors inside `fn` are caught and logged as today; the handler returns normally so the outbox message is deleted (no automatic retry — matches today's semantics; next scheduled tick is the retry).

### Admin manual trigger (unchanged)

```
AdminService.JobControls.runJob(jobName)
  → validation
  → emit 'started' SecurityEvent audit (setImmediate)
  → setImmediate(runJobByName(name, {manualTrigger:true, user}))
    → runWithLock invokes fn directly (bypasses the outbox)
    → completion SecurityEvent audit emitted from runWithLock's finally
```

The manual path never enters the CAP outbox. The 4 admin actions that call `runJobByName(...)` with overrides (`seedSamples`, `seedHelpDocs`, `seedCommunityEvents`, `JobControls.runJob`) are unchanged. `sinceIsoOverride` / `budgetOverride` / `manualTrigger` opts continue to thread through `runJobByName` → `runWithLock` → `fn(logId, opts)` exactly as today.

## Locking model

**Scheduled runs:** CAP 10's `.as(name)` singleton semantics + status-column locking on `cds.outbox.Messages` guarantee at-most-one-in-flight per singleton across all CF instances. When a runner picks up a message, it atomically transitions `status` to `processing`; other runners skip messages in that state.

**Manual triggers:** run in-process via `setImmediate(runJobByName(...))`, bypassing the outbox. A manual trigger firing while a scheduled run of the same job is in-flight is a race that CAP does not resolve. **This is a deliberate behavior change from today.** Today's `JobLocks.acquireLock(jobName, ...)` returns `false` on collision and `runWithLock` returns `{skipped:true, reason:'lock-held'}`; after this migration, both runs proceed to completion. Trade-off argument:

- Frequency is bounded — admin manual triggers are a human action, cron ticks are minutes-apart at fastest.
- Behavior is well-defined — both runs record PipelineLog rows; JobLastRun is UPSERTed in `finally`; either outcome (last-write-wins) is valid.
- Cleaner alternative would be to route manual triggers through `.after(0)` on the outbox, but that defers the "run started" audit event, complicates the current admin UI response shape (`{jobName, started, skipped, reason, startedAt}`), and gains nothing operationally.

## Boot ordering

`CronService.init()` runs as CAP's normal service-load step. The `served` hook in `server.js` that previously called `registerJobs()` is removed. CronService is the sole owner of the scheduler lifecycle.

Rationale: `srv.schedule(...)` requires the service init to have completed (outbox wiring). Calling from a `served` hook forces registerJobs to run in two related phases; owning the whole flow in `init()` is cleaner and matches CAP guide patterns.

**Idempotency:** `.schedule(name, {}).every(expr).as(jobName)` is documented as an upsert on the singleton name. Restarts and rolling deploys are safe — no duplicate schedules pile up.

**Multi-instance boot race:** Two CF instances both running `CronService.init()` simultaneously both call `schedule().as('cleanup-step-failures')`. `.as(name)` upsert semantics resolve this deterministically — last write wins, both write identical rows.

**Registration failure:** if `registerJob()` throws (e.g. duplicate jobName from a code bug), `CronService.init()` throws → CAP fails to start the service → the app crashes on boot. This matches today's behavior and is an explicit choice: fail loud on registration bugs.

## Testing strategy

### Unit tests

**Unchanged (zero edits needed):**
- `test/unit/srv/admin-job-controls.test.js` — admin `runJob` action wiring
- `test/unit/srv/run-job-by-name-opts.test.js` — opts threading (logId, opts as 2nd positional arg)
- `test/unit/srv/job-controls-boot-seed.test.js` — `preSeedJobLastRun` idempotency
- `test/unit/srv/admin-seed-community-events.test.js` — source-string assertion on the seed handlers
- `test/lib/job-log-items.test.js` — pipeline log item helpers

**Adjusted:**
- `test/unit/srv/run-with-lock.test.js` — remove the `lock-held` branch tests (path is deleted). Keep success + error path assertions verbatim. If the file mocks `job-lock.js`, that mock is removed.

**Added:**
- `test/unit/srv/cron-service.test.js` — exercises:
  1. `CronService.init()` populates `JOB_REGISTRY` via `registerJobs`, then wires one handler + one `schedule()` call per job.
  2. Handler dispatch: emitting `cron.<name>` invokes the matching `runJobByName(name)` (mocked).
  3. Idempotency: two `init()` calls do not double-schedule (or, equivalently, `.as(name)` is upsert-safe under the test's mocked schedule).
  4. Missing job in registry when a handler fires: `runJobByName` throws the documented `Unknown jobName` error (matches current shape).

  Mocking: vitest spies on `cds.services.CronService.schedule` and `.on`. No real outbox needed.

### Hybrid tests

- `test/hybrid/admin-run-job.test.js` — read carefully. If any assertion depends on the `skipped:true, reason:'lock-held'` shape, it is replaced with an assertion that manual and scheduled paths coexist without duplicating `PipelineLog` rows.

- **Added:** `test/hybrid/cron-service-schedule.test.js` — boots CAP against real HANA, asserts that after startup `cds.outbox.Messages` contains one pending message per registered job with the expected singleton names. Catches config regressions (accidental protocol exposure, missing schedule call) that unit mocks cannot.

### Manual verification (once, before merge)

1. Local `cds watch` — boot, wait 6 minutes, confirm `metrics-rollup` fires and writes a `MetricSnapshots` row.
2. Local `cds watch` — trigger `AdminService.JobControls.runJob('publish-stuck-manifest-watchdog')` from an authenticated admin session; confirm one `PipelineLog SUCCESS` row, one `JobLastRun` row, and two `SecurityEvent` audit rows (`started` + `success`).
3. Local `cds watch` — restart the process while a schedule is active; confirm exactly one message per job in `cds.outbox.Messages` (no duplicates).
4. Hybrid (`cds bind --exec`) — repeat 1–3 against real HANA to confirm status-column locking works on the real DB.

## Rollout plan

**Staged commits inside a single PR** — allows independent revert points during DEV soak. The **Component design** and **Data flow** sections above describe the *end state* after Commit 4. Intermediate commits temporarily retain code that later commits delete; each commit is called out below.

### Commit 1 — Add CronService, run both engines in parallel

- Add `srv/cron-service.cds` + `srv/cron-service.js`.
- CronService.init() calls `registerJobs()` + `preSeedJobLastRun()` + wires `schedule()` calls.
- `srv/jobs/scheduler.js` still contains `cron.schedule()` inside `registerJob()`.
- Add feature flag `CAP_SCHEDULING_ENABLED` (default `true`) gating the `srv.schedule(...)` calls in `CronService.init()`.
- Deploy to DEV; observe 24h.

Both engines fire during this window. `runWithLock`'s `JobLocks` guarantees no double-execution.

### Commit 2 — Cut over: delete node-cron from `registerJob`

- Remove `cron.schedule(...)` from `registerJob()`.
- Remove `import cron from 'node-cron';`.
- Keep `JobLocks` in place (still called by `runWithLock`).
- Delete the `served`-hook block in `server.js` that calls `registerJobs()`.

Point of no return for node-cron. `.as(name)` locking is now the only mechanism preventing duplicate scheduled ticks; `JobLocks` continues to protect against manual-vs-scheduled races that still exist.

### Commit 3 — Drop JobLocks

- Remove `acquireLock`/`releaseLock` calls from `runWithLock`.
- Remove the "lock-held" branches, associated audit emission, and their unit tests.
- Delete `srv/jobs/job-lock.js`.
- Remove the `JobLocks` entity from `db/schema.cds`.
- Run `cds build --production` to regenerate `db/last-dev/`.
- Adjust `test/unit/srv/run-with-lock.test.js`.

### Commit 4 — Cleanup

- Drop `node-cron` from `dependencies` in `package.json`.
- Remove the `CAP_SCHEDULING_ENABLED` feature flag (permanent-on).
- Update `srv/jobs/scheduler.js` header docstring to describe the new engine.
- Update `docs/developers/reference/tutorials-ims-gotchas.md` if it mentions node-cron.
- Update `CLAUDE.md` `## Architecture` block: "Jobs in `srv/jobs/` (scheduler.js)" gains a note pointing to CronService.
- Update `docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md` "Chassis" section with a pointer to this spec and a note that `JobLocks` was retired.

**Kept dependency:** `cron-parser@5.6.1` (`srv/lib/cron-firings.js` uses it for `nextRunIso` in the admin tile).

## Deployment posture

- Merge Commit 1 → deploy to DEV → observe 24h.
- Merge Commits 2–4 as one squash PR → deploy to DEV → observe 48h → PROD-freeze evaluation.
- Rollback plan for Commit 2: revert the commit; node-cron resumes owning scheduling. `srv.schedule()` calls remain but land in an outbox that nothing else reads — harmless.
- Rollback plan post-Commit 3: full revert of the PR. `JobLocks` entity comes back via schema regeneration.

The `CAP_SCHEDULING_ENABLED` flag is set in `deploy/dev.mtaext`, not code defaults — so a full rollback pins to node-cron via env var without a code redeploy. Removed cleanly in Commit 4.

## HANA schema cleanup

The `JobLocks` table remains in HANA after Commit 3 — removing an entity from `db/schema.cds` does not `DROP TABLE`. Dead but not harmful (small table, zero writes). Follow-up cleanup ticket (not this PR): `hdi undeploy` of `JobLocks` via a targeted `undeploy.json` entry. Explicitly out of scope here to keep the migration reversible.

## Success criteria

- All 32 jobs continue to run on their existing cron expressions with no observable behavior change.
- `AdminService.JobControls.listJobs` still returns rows with `nextRunIso` populated.
- `AdminService.JobControls.runJob('<name>')` still triggers a manual run, still emits `started` + completion `SecurityEvent` audits.
- `test/hybrid/admin-run-job.test.js` passes green.
- `package.json` no longer has `node-cron` in `dependencies`.
- `srv/jobs/job-lock.js` and the `JobLocks` entity are gone from source.
- `cds build --production` regenerates `db/last-dev/` cleanly with `JobLocks` removed.

## References

- CAP 10 release notes — Scheduling API: <https://cap.cloud.sap/docs/releases/2026/jun26#scheduling-api>
- CAP Event Queues guide: <https://cap.cloud.sap/docs/guides/events/event-queues>
- Predecessor upgrade PR: #957
- Admin trigger chassis spec: `docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md`
- Current chassis source: `srv/jobs/scheduler.js`, `srv/jobs/job-lock.js`
- Admin runtime coupling: `srv/admin-service.js:2223`, `:2259`, `:2291`, `:2357`
