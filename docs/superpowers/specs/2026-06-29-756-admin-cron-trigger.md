# Admin self-service cron trigger — design spec

- **Status:** Approved (2026-06-29), pending spec-reviewer pass
- **Issue:** [#756](https://github.com/sap-tutorials/tutorials-ims/issues/756)
- **Surfaced during:** Phase 4.5 implementation (#746). Three failure modes when trying to invoke `runExtractConcepts()` out-of-band: `cf ssh` + `node -e` hit `cds.entities is not a function`; `npm run kg:reextract` hit the same bug (fixed in #762); waiting for the scheduled 02:13 UTC run was ~13 hours. Operators need a self-service path.
- **Sibling fix already merged:** [#762](https://github.com/sap-tutorials/tutorials-ims/pull/762) — `kg-reextract.cjs` now loads `cds.model` before `connect.to('db')`. CLI path works again. This PR adds the **admin-UI** path on top.

## 1. Summary

A single XSUAA-gated admin action that lets an operator trigger any of the 24 cron jobs registered in `srv/jobs/scheduler.js` on demand. The same chassis improvement (scheduler registry refactor) lets every scheduled cron run automatically write a `JobLastRun` row — turning the Phase 4.5 admin "Cron health" tile from a one-job stub into a useful operator dashboard covering all 24 jobs.

The feature ships three coordinated pieces:

1. **Scheduler refactor** — replace the implicit `cron.schedule(...)` ↔ runner-fn mapping with an explicit `JOB_REGISTRY: Map<jobName, JobDef>`. Both scheduled and manual invocations read from this same map. ~300 LoC mechanical refactor.
2. **`AdminService.JobControls` singleton + 2 actions** — `listJobs()` returns the registry catalog with computed `nextRunIso`; `runJob(jobName)` fires `setImmediate(() => runJobByName(jobName, {manualTrigger: true, user}))` and returns `{started: true, ...}` immediately.
3. **Admin UI tile extension** — extend the Phase 4.5 "Cron health" panel in `Board.view.xml` with 3 new columns: Schedule, Next run, "Run now" button. Client-side JOIN of `listJobs()` + `JobLastRun`. Optimistic isRunning flag + 5-minute poll-after-trigger for completion feedback.

Locking, audit emission, and lifecycle behavior all lift the existing Phase 4.5 chassis verbatim. No new locking machinery, no new audit emitter, no new entity. The structural change is the scheduler-registry refactor, which is mechanical but high-leverage — also unblocks future per-job admin config + schedule overrides without scoping them now.

## 2. Scope

### In scope

- New file: none. Refactor of `srv/jobs/scheduler.js`; additions to `srv/admin-service.cds` + `.js`; extensions to `app/admin-shell/webapp/view/Board.view.xml` + controller.
- `JOB_REGISTRY: Map<string, JobDef>` populated by `registerJob({...})` calls inside `registerJobs()`.
- `runWithLock(jobName, ttlMs, fn, opts = {manualTrigger, user})` — backward-compatible 4th opts arg. Always writes `JobLastRun` row on completion (success or error) regardless of which path invoked it.
- `runJobByName(jobName, opts)` — the runner used by both scheduled and manual paths.
- `recordJobLastRun(jobName, outcome, errorMessage)` — already exists from Phase 4.5; now invoked unconditionally inside `runWithLock` finally-block (Phase 4.1-4.4 retrofit via the chassis change, not via per-cron edits).
- `cds.on('served')` pre-seed of `JobLastRun` — one row per registered job, idempotent across restarts.
- `AdminService.JobControls` singleton: `@odata.singleton @requires: 'Admin'`.
- Action `listJobs() returns array of { jobName, schedule, ttlMs, description, nextRunIso }`.
- Action `runJob(jobName: String) returns { jobName, started, skipped, reason, startedAt }`.
- Two `SecurityEvent` audit emissions per manual trigger: `outcome: 'started'` synchronously, `outcome: 'success' | 'error' | 'lockheld'` after completion.
- New npm dependency: `cron-parser` (for `nextRunIso` computation). Added with `--save-exact` per project npm policy.
- Admin UI: 3 new columns in the Cron health Table (Schedule, Next run, Run now). Client-side JOIN. Optimistic isRunning flag. 5-minute poll-after-trigger. Mobile-friendly via UI5's default Table responsive behavior.
- Test triad: unit (registry, runJob, listJobs, UI controller), hybrid (BLOCKED-until-deploy end-to-end against a no-op job).

### Out of scope

- Per-job parameter overrides via UI (e.g. "Run extractConcepts with cap=50"). v2 — needs richer action shape.
- Schedule overrides at runtime (changing the cron expression via UI). v2 — would need a `JobSchedule` overrides table.
- Per-job throttle / rate-limiting beyond the existing lock-already-held behavior. v2 if abuse surfaces.
- Separate admin sub-page for Job controls. Current Board tile suffices at 24 jobs; sub-page is over-engineering today.
- Visual "age > N days" highlight on tile rows. v2 polish.
- Auto-refresh interval shorter than 30s. v2 if operators want it.
- WebSocket push of `JobLastRun` changes. v2 if polling is too coarse.
- Bulk operations (e.g. "run all extraction crons"). v2.

## 3. Architectural decisions (Q1-Q9)

Nine decisions resolved during brainstorming, with rationale:

| # | Decision | Rationale |
|---|---|---|
| Q1 | **Scheduler registry refactor** — `JOB_REGISTRY: Map<jobName, JobDef>` as single source of truth | Both scheduled and manual invocations need the same `jobName → fn` mapping. Two-source-of-truth approaches drift; the lockstep test approach catches it but adds friction. The refactor is mechanical — each `cron.schedule(...)` block becomes a 6-line `registerJob({...})` declaration. Also future-proofs per-job admin config + UI-driven schedule overrides. |
| Q2 | **Decline politely on lock-held** — reuse `acquireLock` | Reusing the existing chassis is maximum simplicity. Queue-for-next-slot adds plumbing + lost-row risk. Force-acquire is race-prone (could kill a 28-min-into-30-min cron mid-write). The audit + JobLastRun row provide the durable signal when a manual trigger lost the lock race. |
| Q3 | **Fire-and-forget response** — return `{started: true}` immediately; observe completion via JobLastRun | Some crons run 10+ minutes; approuter timeout is 30s. Sync-await would error the admin UI before the cron finished. Matches `seedEmbeddings` + `seedApiDocs` precedents — those already return immediately. Operator looks at the JobLastRun tile for completion. |
| Q4 | **Retrofit all 24 crons** via the runWithLock wrapper | The Phase 4.5 admin tile was lonely with only `fetch-api-docs` writing JobLastRun. The retrofit is ONE LINE inside `runWithLock` finally-block — `await recordJobLastRun(jobName, outcome, errorMessage)`. Every scheduled cron retroactively gains visibility. Operator value: massive. Implementation cost: trivial. |
| Q5 | **New `JobControls` singleton** — not extending KnowledgeGraphSettings | Cron management isn't KG-specific. Clean separation: KG settings vs job control. Future scheduler features (schedule overrides, per-job config) get a natural home. The cost is one CDS singleton (negligible). |
| Q6 | **Inline button per row** in the existing Cron health tile | The Phase 4.5 tile already shows the relevant data. Adding a 6th column is the smallest UX delta. Separate panel with dropdown is appropriate at 100+ jobs; we have 24. Sub-page adds navigation steps for what should be one click. |
| Q7 | **Pre-seed JobLastRun on boot** — idempotent UPSERT of one row per registered job in `cds.on('served')` | Without pre-seed, fresh deploys show empty tile until each cron has fired at least once — that's bad first-impression UX. Pre-seed costs 24 INSERTs once per restart; negligible. Restart-safe via existing-row filter. |
| Q8 | **Show cron + computed next-run time** via `cron-parser` lib server-side | Operator wants both "when did it last succeed" and "when will it run next" at a glance. The cron string alone is opaque to non-experts. Computing nextRunIso server-side via `cron-parser` avoids client-side parsing complexity. One small new dep (`cron-parser`); pinned via `--save-exact`. |
| Q9 | **Two SecurityEvents per click** — at trigger time (`outcome: 'started'`) and at completion (`outcome: 'success' | 'error' | 'lockheld'`) | Richer audit trail. The fire-and-forget response means we'd lose the completion record without the second event. Two events per click is cheap; the audit log is built for this scale. |

## 4. Architecture

### 4.1 `JOB_REGISTRY` + `JobDef` shape

```javascript
// srv/jobs/scheduler.js
//
// JOB_REGISTRY is the single source of truth for all scheduled jobs.
// Both cron.schedule() and AdminService.JobControls.runJob() read from here.
const JOB_REGISTRY = new Map();

/**
 * @typedef {Object} JobDef
 * @property {string} jobName
 * @property {string} schedule         e.g. '23 4 1 * *'
 * @property {number} ttlMs            lock duration in ms
 * @property {string} description      human-readable, shown in admin tile
 * @property {Function} fn             () => Promise<unknown>
 */

function registerJob({ jobName, schedule, ttlMs, description, fn }) {
  if (JOB_REGISTRY.has(jobName)) {
    throw new Error(`Duplicate jobName: ${jobName}`);
  }
  JOB_REGISTRY.set(jobName, { jobName, schedule, ttlMs, description, fn });
  cron.schedule(schedule, () => runJobByName(jobName));
}

async function runJobByName(jobName, opts = {}) {
  const job = JOB_REGISTRY.get(jobName);
  if (!job) throw new Error(`Unknown jobName: ${jobName}`);
  return runWithLock(job.jobName, job.ttlMs, job.fn, opts);
}

// Test seams (production code MUST NOT use these).
export function _getJobRegistry() { return JOB_REGISTRY; }
export function _resetJobRegistry() { JOB_REGISTRY.clear(); }
export function _setJobFn(jobName, mockFn) {
  const existing = JOB_REGISTRY.get(jobName);
  if (!existing) throw new Error(`Cannot mock unknown job: ${jobName}`);
  JOB_REGISTRY.set(jobName, { ...existing, fn: mockFn });
}
```

### 4.2 Refactored `registerJobs()` shape

Every `cron.schedule(...)` block becomes a declaration. Example:

```javascript
// Before:
cron.schedule('0 0 * * *', () =>
  runWithLock('cleanup-step-failures', 3600000, () => cleanupStepFailures(90))
);

// After:
registerJob({
  jobName: 'cleanup-step-failures',
  schedule: '0 0 * * *',
  ttlMs: 3600000,
  description: 'Delete StepFailures older than 90 days',
  fn: () => cleanupStepFailures(90),
});
```

24 such blocks. Mechanical edit.

### 4.3 `runWithLock` extension

Backward-compatible 4th opts arg `{manualTrigger = false, user = null}`. Existing 3-arg callers continue working. The key new behavior is **`recordJobLastRun` always invoked** in the finally block:

```javascript
async function runWithLock(jobName, ttlMs, fn, opts = {}) {
  const instanceId = process.env.CF_INSTANCE_GUID ?? `local-${process.pid}`;
  const acquired = await acquireLock(jobName, instanceId, ttlMs);
  if (!acquired) {
    if (opts.manualTrigger) {
      await emitJobAudit({ jobName, user: opts.user, outcome: 'lockheld' });
    }
    return { skipped: true, reason: 'lock-held' };
  }

  let outcome = 'success';
  let errorMessage = null;
  let result = null;
  const startedAt = new Date();
  let logId = null;
  try {
    logId = await startPipelineLog(jobName);
    result = await fn(logId);
    await endPipelineLog(logId, 'SUCCESS', jobName, formatJobSummary(jobName, result));
  } catch (err) {
    outcome = 'error';
    errorMessage = err.message ?? String(err);
    LOG.error(`${jobName}: ${errorMessage}`);
    if (logId) await endPipelineLog(logId, 'FAILED', jobName, errorMessage);
  } finally {
    await releaseLock(jobName, instanceId);
    try {
      await recordJobLastRun(jobName, outcome, errorMessage);
    } catch (err) {
      LOG.warn(`recordJobLastRun ${jobName} failed: ${err.message}`);
    }
    if (opts.manualTrigger) {
      await emitJobAudit({
        jobName,
        user: opts.user,
        outcome,
        durationMs: Date.now() - startedAt.getTime(),
      });
    }
  }
  return { skipped: false, outcome, result, errorMessage };
}
```

**The JobLastRun write is guarded** — if it throws (e.g. DB connection blip), we log a warning but don't fail the cron. The cron's primary work + lock release already completed; persisting last-run state is a "nice to have" relative to those.

### 4.4 Pre-seed JobLastRun on boot

```javascript
// srv/server.js (or scheduler.js)
cds.on('served', async () => {
  try {
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const knownJobs = Array.from(JOB_REGISTRY.keys());
    const existing = await SELECT.from(JobLastRun).columns('jobName');
    const existingNames = new Set(existing.map(r => r.jobName));
    const toInsert = knownJobs
      .filter(name => !existingNames.has(name))
      .map(name => ({ jobName: name }));
    if (toInsert.length > 0) {
      await INSERT.into(JobLastRun).entries(toInsert);
      LOG.info(`pre-seeded ${toInsert.length} JobLastRun rows`);
    }
  } catch (err) {
    LOG.warn(`JobLastRun pre-seed failed: ${err.message}`);
  }
});
```

Idempotent. New jobs added to the registry post-deploy auto-appear on next boot. Removed jobs leave behind harmless dead rows (manual cleanup if it ever becomes a problem; YAGNI today).

### 4.5 `AdminService.JobControls` singleton + actions

`srv/admin-service.cds` — add a new sibling singleton:

```cds
// Phase 4.5 follow-up (#756): generic admin trigger for any registered cron job.
@odata.singleton
@requires: 'Admin'
entity JobControls {
  key label : String default 'Job controls';

  actions {
    action listJobs() returns array of {
      jobName     : String;
      schedule    : String;
      ttlMs       : Integer;
      description : String;
      nextRunIso  : String;
    };

    action runJob(jobName: String) returns {
      jobName   : String;
      started   : Boolean;
      skipped   : Boolean;
      reason    : String;
      startedAt : Timestamp;
    };
  };
}
```

### 4.6 `listJobs` handler

```javascript
// srv/admin-service.js
import parser from 'cron-parser';
import { _getJobRegistry } from './jobs/scheduler.js';

this.on('listJobs', 'JobControls', async () => {
  const registry = _getJobRegistry();
  return Array.from(registry.values()).map(job => {
    let nextRunIso = null;
    try {
      nextRunIso = parser.parseExpression(job.schedule, { utc: true }).next().toISOString();
    } catch (err) {
      LOG.warn(`listJobs: cron-parser failed on '${job.schedule}': ${err.message}`);
    }
    return {
      jobName: job.jobName,
      schedule: job.schedule,
      ttlMs: job.ttlMs,
      description: job.description,
      nextRunIso,
    };
  });
});
```

Guards against `cron-parser` failures — surfaces null `nextRunIso` if parsing fails rather than 500ing the whole catalog.

### 4.7 `runJob` handler

```javascript
this.on('runJob', 'JobControls', async (req) => {
  const { jobName } = req.data;
  const registry = _getJobRegistry();
  if (!registry.has(jobName)) {
    return req.reject(400, `Unknown jobName: ${jobName}`);
  }
  const user = req.user?.id ?? 'unknown';
  const startedAt = new Date();

  // Audit "started" event.
  setImmediate(() => {
    emitJobAudit({ jobName, user, outcome: 'started', startedAt })
      .catch(err => LOG.warn(`audit emission failed: ${err.message}`));
  });

  // Fire the cron run in the background.
  setImmediate(() => {
    runJobByName(jobName, { manualTrigger: true, user })
      .catch(err => LOG.error(`runJob ${jobName} failed: ${err.message}`));
  });

  return {
    jobName,
    started: true,
    skipped: false,
    reason: null,
    startedAt,
  };
});
```

The handler responds with `started: true` even if the lock turns out to be held — the lock check happens inside `runJobByName` (which calls `runWithLock` → `acquireLock`), and the lock-held outcome surfaces via the second audit event + `JobLastRun.lastErrorMessage` if appropriate. The alternative (synchronously check lock before responding) creates a TOCTOU race with `runWithLock`'s own acquisition. The fire-and-forget posture is cleaner.

### 4.8 `emitJobAudit` helper

Lives in `srv/admin-service.js` near the existing `createAuditEmitter`:

```javascript
async function emitJobAudit({ jobName, user, outcome, durationMs = null, startedAt = null }) {
  return auditEvent('cron.manual-trigger', {
    jobName,
    user,
    outcome,
    ...(durationMs != null && { durationMs }),
    ...(startedAt != null && { startedAt: startedAt.toISOString() }),
  });
}
```

`auditEvent` is the closure produced by `createAuditEmitter(auditLog, LOG)` already wired up in `srv/admin-service.js` for `seedApiDocs` and the Secrets actions. If the audit-log binding is unavailable, the closure falls back to a `LOG.warn`. No new audit-event infrastructure.

### 4.9 Admin UI — Board.view.xml extension

The existing Phase 4.5 "Cron health" Table gets 3 new columns and a `<Button>` cell:

```xml
<Panel headerText="Cron health">
  <Table id="cronHealthTable" items="{path: 'jobControls>/jobs'}">
    <columns>
      <Column><Text text="Job"/></Column>
      <Column><Text text="Schedule"/></Column>
      <Column><Text text="Next run"/></Column>
      <Column><Text text="Last success"/></Column>
      <Column><Text text="Last error"/></Column>
      <Column hAlign="End"><Text text="Trigger"/></Column>
    </columns>
    <items>
      <ColumnListItem>
        <cells>
          <Text text="{jobControls>jobName}"/>
          <Text text="{jobControls>schedule}" class="kg-mono"/>
          <Text text="{path: 'jobControls>nextRunIso', formatter: '.formatNextRun'}"/>
          <Text text="{path: 'jobControls>lastSuccessAt', formatter: '.formatRelativeTime'}"/>
          <Text text="{jobControls>lastErrorMessage}" tooltip="{jobControls>lastErrorMessage}"/>
          <Button text="Run now" type="Emphasized" press=".onRunJob"
                  busy="{jobControls>isRunning}" busyIndicatorDelay="0"/>
        </cells>
      </ColumnListItem>
    </items>
  </Table>
</Panel>
```

### 4.10 Board.controller.js extension

Three additions: load-and-JOIN logic, onRunJob press handler, post-trigger polling.

```javascript
async _loadJobControls() {
  const adminModel = this.getOwnerComponent().getModel('admin');
  const jobControlsModel = new JSONModel({ jobs: [] });
  this.getView().setModel(jobControlsModel, 'jobControls');

  // Fetch listJobs + JobLastRun in parallel.
  const [jobsResp, lastRuns] = await Promise.all([
    this._callListJobs(adminModel),
    this._loadJobLastRunRows(adminModel),
  ]);

  const lastRunsByName = new Map(lastRuns.map(r => [r.jobName, r]));

  const joined = jobsResp.map(j => ({
    ...j,
    lastSuccessAt: lastRunsByName.get(j.jobName)?.lastSuccessAt ?? null,
    lastErrorAt: lastRunsByName.get(j.jobName)?.lastErrorAt ?? null,
    lastErrorMessage: lastRunsByName.get(j.jobName)?.lastErrorMessage ?? null,
    isRunning: false,
  }));

  jobControlsModel.setProperty('/jobs', joined);
}

async onRunJob(oEvent) {
  const ctx = oEvent.getSource().getBindingContext('jobControls');
  const jobName = ctx.getProperty('jobName');
  const idx = parseInt(ctx.getPath().split('/').pop(), 10);
  const model = this.getView().getModel('jobControls');

  model.setProperty(`/jobs/${idx}/isRunning`, true);

  try {
    const result = await this._callRunJob(jobName);
    if (result.started) {
      MessageToast.show(`${jobName}: started`);
      this._scheduleJobControlsRefresh();
    } else {
      MessageToast.show(`${jobName}: ${result.reason ?? 'skipped'}`);
      model.setProperty(`/jobs/${idx}/isRunning`, false);
    }
  } catch (err) {
    MessageBox.error(`Failed to start ${jobName}: ${err.message}`);
    model.setProperty(`/jobs/${idx}/isRunning`, false);
  }
}

_scheduleJobControlsRefresh() {
  if (this._pollHandle) return;
  let elapsed = 0;
  const POLL_INTERVAL_MS = 30000;
  const POLL_MAX_MS = 5 * 60 * 1000;
  this._pollHandle = setInterval(async () => {
    elapsed += POLL_INTERVAL_MS;
    await this._loadJobControls();
    if (elapsed >= POLL_MAX_MS) {
      clearInterval(this._pollHandle);
      this._pollHandle = null;
    }
  }, POLL_INTERVAL_MS);
}
```

Helper methods `_callListJobs` and `_callRunJob` wrap the OData v4 bindContext / setParameter / execute dance — kept separate for testability.

Formatters:
- `formatNextRun(iso)` — humanizes to "in 14 hours" (< 24h) or "Sun 03:13 UTC" (> 24h). Inline helper, no new dep.
- `formatRelativeTime(iso)` — "5 minutes ago" / "Never" / etc. Mirror of existing helper in the same controller.

### 4.11 CSS

One addition to `app/admin-shell/webapp/css/style.css` (or wherever Board.view.xml's CSS lives):

```css
.kg-mono {
  font-family: var(--sapFontFamily, monospace);
  font-size: 0.9em;
}
```

## 5. Telemetry

Two `SecurityEvent` audit emissions per manual `runJob` invocation. Event `action: 'cron.manual-trigger'`:

| Phase | When | Detail |
|---|---|---|
| `started` | Synchronously on action invocation, BEFORE response returns | `{jobName, user, outcome: 'started', startedAt}` |
| Completion | After cron fn resolves OR throws OR lock-held | `{jobName, user, outcome: 'success' | 'error' | 'lockheld', durationMs}` |

Both emitted via `setImmediate` (fire-and-forget) to match `seedApiDocs` precedent. If audit-log binding is unavailable, the closure logs a warning.

No new telemetry event types beyond `SecurityEvent` (which is the only event name registered in the project's audit-log config).

## 6. Concurrency safety

- **Manual trigger collides with scheduled cron:** `acquireLock` returns false → handler returns `{started: false, skipped: true}` immediately, audit emits `outcome: 'lockheld'`. Operator sees toast "fetch-api-docs: lock-held".
- **Multiple operators click "Run now" simultaneously:** the first acquires the lock; subsequent invocations see `lockheld`. Same path as above.
- **Operator clicks "Run now" while their own previous click is still running:** lock is held; toast shows "lock-held"; tile already shows `isRunning: true`. Operator sees the same UX as the multi-operator case.
- **Cron job has no JobLastRun row yet:** the pre-seed on boot ensures every registered job has a row. Tile renders with `lastSuccessAt: null`.
- **Cron registration grows or shrinks across deploys:** the boot-time pre-seed handles additions; removals leave dead rows that don't affect operations.

## 7. Test strategy

### 7.1 Unit tests (in-memory SQLite via `cds.test()`)

- `test/unit/srv/scheduler-registry.test.js` — 4 cases:
  1. `registerJob({...})` populates `JOB_REGISTRY`
  2. Duplicate `jobName` throws
  3. `_getJobRegistry()` reflects all registered jobs after `registerJobs()`
  4. `runJobByName(unknownName)` throws

- `test/unit/srv/run-with-lock.test.js` — 3 cases:
  1. Successful fn: returns `{outcome: 'success'}`, writes JobLastRun.lastSuccessAt
  2. Failing fn: returns `{outcome: 'error'}`, writes JobLastRun.lastErrorMessage
  3. Lock-held: returns `{skipped: true}`, audit event emitted when `manualTrigger: true`

- `test/unit/srv/admin-job-controls.test.js` — 6 cases:
  1. `runJob(knownName)` returns `{started: true, startedAt}` synchronously
  2. `runJob(unknownName)` rejects with 400
  3. `runJob` invokes runJobByName exactly once (via mock fn registered with `_setJobFn`)
  4. `runJob` emits the 'started' audit event in setImmediate
  5. `runJob` emits the completion audit event after mock fn resolves (success path)
  6. `listJobs` returns one entry per registered job with `nextRunIso` populated

- `test/unit/srv/job-controls-boot-seed.test.js` — 2 cases:
  1. Pre-seed inserts one row per registered job on first boot (empty JobLastRun)
  2. Pre-seed is idempotent — re-running adds zero rows when all jobs already have a row

- `test/unit/admin-shell/board-controller-job-controls.test.js` — 2 cases:
  1. `_loadJobControls()` joins listJobs + JobLastRun correctly
  2. `onRunJob()` invokes the action with correct jobName and shows toast on success

### 7.2 Hybrid test (real HANA via `cds bind --exec`)

- `test/hybrid/admin-run-job.test.js` — 1 case (BLOCKED-until-deploy):
  - Register a `_test-noop` job in `JOB_REGISTRY` (test-only registration via `_setJobFn`).
  - Invoke `AdminService.JobControls.runJob('_test-noop')`.
  - Wait for `JobLastRun.lastSuccessAt` to update.
  - Verify the audit log received exactly two `cron.manual-trigger` events (started + success).
  - Cleanup: remove the test-only registration.

### 7.3 Smoke test (HTTP against deployed)

Existing smoke suite probes admin endpoints already. Adding `JobControls` to the OData metadata is the only deploy-time change; no new smoke file required.

## 8. Acceptance criteria

When this ships and deploys to DEV, all of these are true:

1. `JOB_REGISTRY` in `srv/jobs/scheduler.js` has exactly one entry per current cron job — verified by a lockstep test asserting `_getJobRegistry().size === 24`.
2. `registerJobs()` refactored — no bare `cron.schedule()` calls remain.
3. `runWithLock` extended with optional 4th opts arg `{manualTrigger, user}`. Existing 3-arg call sites continue working.
4. `recordJobLastRun` invoked from `runWithLock` finally-block for every scheduled AND manual cron — Phase 4.1-4.4 + 4.5 cron history visible to operators after this PR deploys.
5. `cds.on('served')` pre-seeds `JobLastRun` — one row per registered job, idempotent across restarts.
6. `AdminService.JobControls` singleton declared with `@requires: 'Admin'`.
7. `listJobs()` action returns 24 entries with valid `nextRunIso` for every cron schedule.
8. `runJob(jobName)` action fires `setImmediate(() => runJobByName(jobName, {manualTrigger: true, user}))` and returns `{started: true, ...}` immediately. Rejects unknown jobNames with 400.
9. Two `SecurityEvent`s emitted per manual trigger — at trigger time (`outcome: 'started'`) and after completion (`outcome: 'success' | 'error' | 'lockheld'`).
10. Admin UI tile renders 6 columns (Job / Schedule / Next run / Last success / Last error / Run now). Pre-seed guarantees all 24 jobs visible from day 1.
11. "Run now" button optimistically sets `isRunning`, invokes the action, shows toast, polls JobLastRun every 30s for the next 5 min for completion.
12. `cron-parser` added to `dependencies` (pinned via `--save-exact`) — only if not already present transitively.
13. Test triad: ~17 unit tests + 1 hybrid (BLOCKED-until-deploy).

## 9. Gotchas & operational notes

### 9.1 `cron-parser` may already be transitive

`node-cron` (the project's scheduler library) doesn't expose a "next fire time" API directly, hence the new `cron-parser` dep. Check before adding — if it's already transitive via some other package, that's fine but lock it directly with `--save-exact` to avoid surprise version drift.

### 9.2 The fire-and-forget response masks lock-held cases in the synchronous HTTP path

A user clicking "Run now" sees a "Started" toast even when the lock turns out to be held. The completion audit event + the JobLastRun row are the durable signals. If operators get confused, we add a 5-second blocking-await poll loop in the controller before showing the toast — but YAGNI in v1; the audit + tile poll are sufficient.

### 9.3 `_test-noop` registration in the hybrid test is global state

The hybrid test mutates `JOB_REGISTRY` via `_setJobFn`. The `afterAll` block MUST `JOB_REGISTRY.delete('_test-noop')` or the test pollutes subsequent runs. Document in the test file.

### 9.4 `recordJobLastRun` failure semantics

If the HANA write fails (DB blip, schema drift, etc.), the cron still succeeded (it's its own primary work). We log a warning and continue. This means JobLastRun can lag reality by up to 24 hours in the worst case (next cron cycle re-writes successfully). For health monitoring this is acceptable; for forensics we have PipelineLog as the second source of truth.

### 9.5 The 30s-interval-for-5-min polling could be optimized

The poll loop is intentionally coarse — 30s × 10 fetches = 10 OData GETs per Run-now click. If the cron is faster (e.g. `cleanup-step-failures` runs in ~200ms), the operator sees the completion within 30s. If the cron is slower (e.g. extractConcepts runs 10 min), the operator gets bored before the tile updates. v2 could add WebSocket push or shorter intervals; v1 keeps it simple.

### 9.6 Multi-instance Cloud Foundry deploys

`acquireLock` uses `CF_INSTANCE_GUID` as the `lockedBy` value, which means two CF instances running the same cron simultaneously won't both fire — the first to insert the JobLocks row wins. For manual triggers, this means: if operator clicks "Run now" on instance 0 and the same cron is already running on instance 1, the manual trigger correctly reports lock-held. Verified by existing JobLocks chassis; no new behavior here.

### 9.7 Schedule format quirks

The `cron-parser` and `node-cron` libraries both accept 5-field cron expressions (minute hour day-of-month month day-of-week). Some libraries support 6-field (with seconds); we don't use that. All 24 current schedules are 5-field. The lockstep test should verify parser compatibility for every registered schedule.

### 9.8 `JobLastRun.lastSuccessAt = null` UI rendering

After pre-seed, fresh rows have null timestamps. The `formatRelativeTime(null)` helper returns `"Never"`. That's the UX — not "—" or empty cell. Same for `lastErrorMessage`.

## 10. Shipping plan summary

Three-task structure, single PR with stacked commits:

| Task | Scope | Commits | LoC est. |
|---|---|---|---|
| **Task 1: Scheduler refactor + JobLastRun retrofit** | `srv/jobs/scheduler.js` registry refactor, `runWithLock` extension, `recordJobLastRun` always-writes, pre-seed on served, lockstep test (24 jobs), 2-3 unit tests | 3-4 | ~300 |
| **Task 2: `JobControls` singleton + handlers** | `srv/admin-service.cds` + `.js` additions, `cron-parser` dep, `emitJobAudit` helper, 6 unit tests, 1 hybrid test | 3 | ~250 |
| **Task 3: Admin UI tile extension** | `Board.view.xml` + `Board.controller.js` changes, formatters, CSS, 2 UI tests | 2 | ~250 |

**Total:** ~50 steps / 8-9 commits / ~800 LoC.

## 11. Future cross-phase impact

- **Phase 4.5 forward compat:** the `fetch-api-docs` JobLastRun row continues working unchanged; this PR just means the OTHER 23 rows start getting written too.
- **Phase 4.6+ (code samples):** every new cron added via `registerJob({...})` automatically gets JobLastRun + Run-now button + audit. No per-phase scaffolding needed. **This is the real long-term win.**
- **Future scheduler features:** v2 schedule overrides via UI would extend `JobDef` with a `scheduleOverride` field stored in a `JobScheduleOverride` entity. The registry refactor already supports this — the dynamic `cron.schedule()` wiring inside `registerJob` is the only place that would need to read the override. v2 per-job parameter overrides extend the runJob action signature without changing the chassis.
