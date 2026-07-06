# #1021 — CAP 10 Outbox Wedge: Belt-and-Suspenders + Operator Recovery

**Issue:** [#1021](https://github.com/sap-tutorials/tutorials-ims/issues/1021) — `extractConcepts` scheduler wedged after 07-04 crash; unstuck via `CDS_OUTBOX_MESSAGES` delete.
**Related:** #1022 (upstream CAP framework hook — not this spec).
**Status:** Design approved 2026-07-06. Ready for implementation planning.

---

## Problem

CAP 10's Scheduling API uses `srv.schedule(...).as(jobName)` as a status-column singleton lock in `cds.outbox.Messages` — a row with `status='processing'` prevents concurrent scheduled ticks across CF instances. When a scheduled tick throws *synchronously* before the framework's finally-flip, the row is left at `status='processing'` and CAP refuses to fire subsequent ticks for that jobName.

On 2026-07-04 the `extractConcepts` tick threw because `resolveChatLlmSettings()` couldn't find a `ChatSettings.deploymentId`. The wedge persisted for 48h — 749 of 1529 ACTIVE tutorials rendered with empty KG `teaches` payloads and the sidebar's hide-on-empty path suppressed every downstream visualization. The failure was silent: no `JobLastRun` row, no `PipelineLog` entry, no red on the Job Log Board.

The manual fix that unstuck DEV:

```sql
DELETE FROM CDS_OUTBOX_MESSAGES WHERE TASK='<jobName>' AND STATUS='processing';
```

This spec covers the in-repo half: belt-and-suspenders in `runWithLock` plus operator recovery in the Cron health panel. The framework half — CAP itself should either finally-flip on throw or expose a hook — is tracked in #1022.

## Goals

1. **Prevent future wedges.** No scheduled tick can leave a stuck `processing` row, whatever the handler does.
2. **Detect existing wedges.** Operators see a "Wedged" red badge on the Cron health panel within one page load of the failure.
3. **Recover from the UI.** One-click `Force unwedge` button clears the stuck row without SSH or `hdbsql`.
4. **Audit the recovery.** Every unwedge lands in `SecurityEvent` with `outcome='unwedged'`.
5. **Portability.** All outbox interactions bind to `cds.entities('cds.outbox').Messages` via CQL — never hardcode `CDS_OUTBOX_MESSAGES` physical column names.

## Non-goals

- **Auto-triggering the missed run.** `forceUnwedge` clears the wedge only; operators click `Run now` separately if they can't wait for the next scheduled tick.
- **A dedicated "Stuck jobs" tile.** The Cron health panel already lists every registered job — the wedge indicator lives inline.
- **Framework fix.** The upstream CAP behavior belongs in #1022.
- **Cross-instance concurrency for `forceUnwedge`.** If two admins click at once, the second gets `{cleared: false}` — that's correct.

## Architecture

Four surfaces change:

```
srv/jobs/scheduler.js
  └── runWithLock  → finally { deleteStuckOutboxRow(); recordJobLastRun(); ... }

srv/lib/scheduler-wedge.js  (NEW)
  ├── deleteStuckOutboxRow(jobName) → Promise<Boolean>
  └── loadStuckOutboxTargets()      → Promise<Map<jobName, true>>

srv/admin-service.cds + .js
  ├── JobControls action `listJobs()` now returns { ..., wedged: Boolean }
  └── JobControls action `forceUnwedge(jobName)` → { jobName, cleared, reason }

app/admin-shell/webapp/
  ├── view/Board.view.xml   → new "Status" column + conditional "Force unwedge" button
  └── controller/Board.controller.js → onForceUnwedge + _callForceUnwedge
```

Belt (framework-side prevention) lives in `runWithLock`. Suspenders (operator recovery when the belt didn't exist yet, or a future belt failure) live in the UI action.

## Part 1 — Belt-and-suspenders in `runWithLock`

**File:** `srv/jobs/scheduler.js:142-184`.

**Change:** In the existing `finally { }` block, call `deleteStuckOutboxRow(jobName)` *before* `recordJobLastRun`. The DELETE runs on both success and failure paths.

```js
} finally {
  await deleteStuckOutboxRow(jobName);   // NEW — belt-and-suspenders
  try {
    await recordJobLastRun(jobName, outcome, errorMessage);
  } catch (err) {
    LOG.warn(`recordJobLastRun ${jobName} failed: ${err.message}`);
  }
  if (opts.manualTrigger) { /* existing audit */ }
}
```

**Helper — `srv/lib/scheduler-wedge.js`:**

```js
import cds from '@sap/cds';
const LOG = cds.log('scheduler-wedge');

export async function deleteStuckOutboxRow(jobName) {
  try {
    const outbox = cds.entities('cds.outbox');
    if (!outbox?.Messages) return false;  // CAP <10 or entity missing
    const db = await cds.connect.to('db');
    const result = await db.run(
      DELETE.from(outbox.Messages).where({ target: `cron.${jobName}` })
    );
    return (result?.affectedRows ?? result ?? 0) > 0;
  } catch (err) {
    LOG.warn(`deleteStuckOutboxRow(${jobName}) failed: ${err.message}`);
    return false;
  }
}
```

**Why `finally` (not `catch`):** the DELETE runs on success too. In the healthy case the framework has already deleted the row and our DELETE is a no-op; the cost is one extra round-trip per tick. In exchange we survive a future framework bug that fails to flip on success too.

**Why the helper returns a boolean:** `runWithLock` ignores the return, but `forceUnwedge` (Part 3) uses it to distinguish "cleared a wedge" from "no wedge existed."

**Field-name caveat:** the CAP 10 outbox message row uses `target` for the event name (`cron.<jobName>`). The hybrid test at `test/hybrid/cron-service-schedule.test.js:40-54` treats the outbox shape as opaque and scans all string columns for the `cron.<name>` substring. Part 0 of the implementation plan (probe) confirms the exact field name at runtime before wiring the helper. If CAP renames the field in a future release we break loudly (query throws) rather than silently (no-op DELETE against wrong column).

**Failure mode of the helper itself:** wrapped in its own try/catch. If DELETE throws, we log and continue to `recordJobLastRun`. Belt fails → suspenders (Part 3 UI) still hold.

## Part 2 — Wedge detection in `listJobs()`

**Files:** `srv/admin-service.cds:310-320`, `srv/admin-service.js:2388-2409`.

**CDS:** add one field to the return shape.

```cds
action listJobs() returns array of {
  jobName     : String;
  schedule    : String;
  ttlMs       : Integer;
  description : String;
  nextRunIso  : String;
  nextRunsIso : array of String;
  wedged      : Boolean;   // NEW
};
```

**Handler:** fetch stuck targets in a single query before the map:

```js
this.on('listJobs', 'JobControls', async () => {
  const registry = _getJobRegistry();
  const now = new Date();
  const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const stuckByJob = await loadStuckOutboxTargets();

  return Array.from(registry.values()).map(job => {
    // ...existing nextRunsIso computation...
    const wedged = stuckByJob.has(job.jobName)
      && !isWithinExpectedTickWindow(job.schedule, now);
    return { jobName: job.jobName, schedule: job.schedule, ttlMs: job.ttlMs,
             description: job.description, nextRunIso, nextRunsIso, wedged };
  });
});
```

**`loadStuckOutboxTargets()`** — new export in `srv/lib/scheduler-wedge.js`:

```js
export async function loadStuckOutboxTargets() {
  const stuck = new Map();
  try {
    const outbox = cds.entities('cds.outbox');
    if (!outbox?.Messages) return stuck;
    const db = await cds.connect.to('db');
    const rows = await db.run(SELECT.from(outbox.Messages));
    for (const row of rows) {
      const status = row.status ?? row.STATUS;
      const target = row.target ?? row.TARGET;
      if (status === 'processing' && typeof target === 'string' && target.startsWith('cron.')) {
        stuck.set(target.slice('cron.'.length), true);
      }
    }
  } catch (err) {
    LOG.warn(`loadStuckOutboxTargets failed: ${err.message}`);
  }
  return stuck;
}
```

Reads broadly and filters in JS (same tactic as the hybrid schedule test) — safest against column-name drift between CAP releases.

**Wedge criterion — `isWithinExpectedTickWindow`:**

A row is *legitimately* `processing` if we're inside the interval between its scheduled fire and the next scheduled fire. Wedged means we've crossed into the following interval without a status flip. Uses `cron-parser` (already imported for `nextRunIso`).

```js
function isWithinExpectedTickWindow(cronExpr, now) {
  try {
    const prev = prevFiringBefore(cronExpr, now);
    const next = nextFiringAfter(cronExpr, prev);
    return now < next;
  } catch {
    return true;  // parse failure — assume healthy, don't false-positive
  }
}
```

**Fail-open policy:** every catch path returns "not wedged." Detection failures never surface as false alarms; the existing `lastErrorAt` staleness signal covers the missed-tick case less specifically.

## Part 3 — `forceUnwedge` action + Cron health UI

### Backend action

**`srv/admin-service.cds`** — after the `runJob` block (~line 328):

```cds
action forceUnwedge(jobName: String) returns {
  jobName   : String;
  cleared   : Boolean;
  reason    : String;
};
```

Auth inherits from `entity JobControls` `@requires: 'Admin'`.

**Handler** — `srv/admin-service.js` after the `runJob` handler:

```js
this.on('forceUnwedge', 'JobControls', async (req) => {
  const { jobName } = req.data;
  if (typeof jobName !== 'string' || jobName.length === 0 || jobName.length > MAX_JOB_NAME_LEN) {
    return req.reject(400, `Invalid jobName (must be non-empty string <=${MAX_JOB_NAME_LEN} chars)`);
  }
  const registry = _getJobRegistry();
  if (!registry.has(jobName)) {
    return req.reject(400, `Unknown jobName: ${jobName}`);
  }
  const user = req.user?.id ?? 'unknown';

  // Audit BEFORE mutation so we always have a record of the intent.
  setImmediate(() => {
    emitJobAudit({ jobName, user, outcome: 'unwedged', startedAt: new Date() })
      .catch(err => LOG.warn(`forceUnwedge audit failed: ${err.message}`));
  });

  const cleared = await deleteStuckOutboxRow(jobName);
  return {
    jobName,
    cleared,
    reason: cleared ? null
      : 'No stuck outbox row found (already clear, or CAP outbox not present)',
  };
});
```

**`emitJobAudit` change:** confirm the `outcome` parameter accepts arbitrary strings; add `'unwedged'` to any enum validator. Existing values: `'started'`, `'success'`, `'error'`.

### Cron health panel — view

**`app/admin-shell/webapp/view/Board.view.xml:82-122`** — two additions to the existing `<Panel headerText="Cron health">`.

**1. New "Status" column** between "Last error" and "Trigger":

```xml
<Column><Text text="Status" /></Column>
...
<cells>
  ...
  <ObjectStatus
    text="{= ${jobControls>wedged} ? 'Wedged' : '' }"
    state="{= ${jobControls>wedged} ? 'Error' : 'None' }"
    visible="{jobControls>wedged}" />
  ...
</cells>
```

**2. Conditional "Force unwedge" button** in the Trigger cell:

```xml
<HBox>
  <Button text="Run now" type="Emphasized" press=".onRunJob"
          busy="{jobControls>isRunning}" busyIndicatorDelay="0" />
  <Button text="Force unwedge" type="Reject" icon="sap-icon://unlocked"
          press=".onForceUnwedge"
          visible="{jobControls>wedged}"
          busy="{jobControls>isUnwedging}" busyIndicatorDelay="0"
          class="sapUiTinyMarginBegin" />
</HBox>
```

### Controller

**`app/admin-shell/webapp/controller/Board.controller.js`** — mirror the existing `onRunJob` / `_callRunJob` pattern (lines 133-173). New methods:

```js
onForceUnwedge: function (oEvent) {
  var oCtx = oEvent.getSource().getBindingContext("jobControls");
  var sJobName = oCtx.getProperty("jobName");
  var oModel = this.getView().getModel("jobControls");
  var iIdx = this._indexOfJob(sJobName);

  MessageBox.confirm(
    "Force-unwedge '" + sJobName + "'? This deletes the stuck outbox row. " +
      "The next scheduled tick will fire normally.",
    {
      title: "Force unwedge",
      onClose: function (sAction) {
        if (sAction !== MessageBox.Action.OK) return;
        oModel.setProperty("/jobs/" + iIdx + "/isUnwedging", true);
        this._callForceUnwedge(sJobName)
          .then(function (oResult) {
            MessageToast.show(oResult.cleared
              ? "Unwedged '" + sJobName + "'"
              : "Not wedged: " + oResult.reason);
            return this._loadJobControls();  // refreshes wedged flag
          }.bind(this))
          .catch(function (err) {
            MessageBox.error("Force unwedge failed: " + (err.message || err));
          })
          .finally(function () {
            oModel.setProperty("/jobs/" + iIdx + "/isUnwedging", false);
          });
      }.bind(this),
    }
  );
},

_callForceUnwedge: function (sJobName) {
  var oAdminModel = this.getOwnerComponent().getModel("admin");
  var oAction = oAdminModel.bindContext("/JobControls/AdminService.forceUnwedge(...)");
  oAction.setParameter("jobName", sJobName);
  return oAction.execute().then(function () {
    return oAction.getBoundContext().getObject();
  });
},
```

**Confirmation dialog rationale:** `runJob` fires without confirm (harmless — just runs a job). `forceUnwedge` deletes a framework-owned row; a confirmation prevents fat-finger recovery during oncall pages.

## Part 4 — Runbook + tests + observability

### Runbook

**New file:** `docs/developers/operations/scheduler-troubleshooting.md`, structured like `content-rollback.md`:

- H1 + one-line intro
- **When to use this** — bullets: no new `JobLastRun.lastSuccessAt` after scheduled fire; no `PipelineLog` rows with `pipelineType='SCHEDULED_JOB'` on expected cadence; red "Wedged" badge on `/admin-ui/#board` Cron health panel
- **When NOT to use** — bullets: job that ran and failed (fix root cause then `Run now`); job still running (check duration vs ttlMs)
- **How the wedge happens** — 2 paragraphs: CAP 10 `.as(name)` status-column lock; synchronous throw before finally-flip; row stuck at `status='processing'`; framework refuses to re-fire while row exists
- **Runbook**
  1. Confirm the wedge — `/admin-ui/#board` → Cron health panel → red "Wedged" badges
  2. Force-unwedge from the UI — click "Force unwedge", confirm, wait for MessageToast
  3. (Optional) Manually trigger — click "Run now" if you can't wait for the next scheduled tick
  4. Verify recovery — `Last success` column advances on next tick; no red badge
- **HANA escape hatch (last resort)** — the original `DELETE FROM CDS_OUTBOX_MESSAGES WHERE TASK='<jobName>' AND STATUS='processing'` SQL via `hana-cli` / `hdbsql` when the UI is unreachable
- **Cross-refs:** #1021, #1022, `srv/jobs/scheduler.js:runWithLock`

Add to `CLAUDE.md` "Deep dives" list under `docs/developers/operations/`.

### Tests

**Unit — extend `test/unit/srv/run-with-lock.test.js`:**

1. On `fn()` throw, `deleteStuckOutboxRow` is invoked before `recordJobLastRun` (spy on both, assert call order).
2. On `fn()` success, `deleteStuckOutboxRow` still runs (idempotent no-op).

**Unit — extend `test/unit/srv/admin-job-controls.test.js`:**

1. `listJobs` returns `wedged: false` for a job with no outbox row.
2. `listJobs` returns `wedged: false` for a job with a `processing` row inside its expected tick window.
3. `listJobs` returns `wedged: true` when the row is stale (past next scheduled fire).
4. `listJobs` returns all `wedged: false` if `cds.entities('cds.outbox')` is missing (fail-open).
5. `forceUnwedge` returns `{cleared: true}` when a `processing` row exists.
6. `forceUnwedge` returns `{cleared: false, reason: '...'}` when no row exists.
7. `forceUnwedge` rejects 400 for unknown/malformed jobName.
8. `forceUnwedge` emits `SecurityEvent` audit with `outcome: 'unwedged'` before DELETE.

**Hybrid — new file `test/hybrid/scheduler-wedge-recovery.test.js`:**

Gated on `ALLOW_HYBRID_WRITES`. Boots CAP against real HANA (mirrors `test/hybrid/cron-service-schedule.test.js`).

1. **Belt self-heal** — register a test job that synchronously throws; force-fire via `runJobByName`; assert `cds.outbox.Messages` row for `cron.<test-job>` is gone after return.
2. **`forceUnwedge` end-to-end** — manually INSERT `{ target: 'cron.<real-job>', status: 'processing' }`; call OData action; assert `{cleared: true}`, row gone, `SecurityEvent` audit landed with `outcome: 'unwedged'`.

**Cleanup:** `afterEach` — `DELETE.from(outbox.Messages).where(target LIKE 'cron.test-%')` plus test-timestamp SecurityEvent cleanup.

### Observability

`SecurityEvent` rows with `outcome='unwedged'` are the audit trail — surfaced in the existing SecurityEvent list report at `/admin-ui/#securityEvents`. No new counters or metric snapshots (YAGNI). If a future need for "wedges per day" emerges, derive it from `SecurityEvent`.

## Memory + docs updates

After the fix lands:

- **Memory (agent-behavior)** — new `cap10-outbox-wedge.md` (feedback): "CAP 10's `.as(name)` status-column singleton lock can wedge on synchronous throws before the framework's finally-flip. Belt-and-suspenders DELETE in `runWithLock` is in place; wedge indicator + `forceUnwedge` on the Cron health panel is the UX recovery path. Refs: #1021, #1022."
- **Docs (platform facts)** — extend `docs/developers/reference/cap-cds-gotchas.md` with a new "CDS outbox internals" section: "The `cds.outbox.Messages` entity is framework-owned. Bind via `cds.entities('cds.outbox').Messages` + CQL; never hardcode `CDS_OUTBOX_MESSAGES` physical column names. Fields `target` (= `cron.<jobName>` for scheduled jobs) and `status` (`processing` when picked up) are the only stable observations across CAP releases."

## Risks & rollback

| Risk | Mitigation |
|---|---|
| Belt DELETE inadvertently clears a legitimate concurrent tick | Impossible in practice: the tick that just returned owns the row; no other instance can be inside `runWithLock` for the same jobName under CAP 10's singleton lock. |
| CAP renames `target` or `status` field in a future release | Boot-time probe (plan Task 0) confirms field names. Runtime failures are logged; belt fails loud, suspenders (UI) fail with an error toast — not silent. |
| `loadStuckOutboxTargets` scans the full outbox on every `listJobs` call | Outbox size is bounded to registered jobs + a small backlog. If profiling shows growth, add a `WHERE status='processing'` filter using the runtime-probed column name. |
| `forceUnwedge` misused (deleting a legitimately-processing row) | Confirmation dialog + `SecurityEvent` audit. Wedge criterion in `listJobs` prevents the button from appearing unless the wedge is genuine. |

**Rollback:** each of the three commits is independent.

1. Revert the `runWithLock` DELETE call — reverts belt only.
2. Revert the `forceUnwedge` action + UI additions — reverts suspenders only.
3. Revert the `wedged` field in `listJobs` — reverts detection only (button hides automatically because visibility binds to `wedged`).

## References

- `srv/jobs/scheduler.js:142-184` — `runWithLock` chassis
- `srv/cron-service.js:34-42` — `.every(schedule).as(jobName)` wiring
- `srv/admin-service.cds:299-329` — existing JobControls entity + `runJob` pattern
- `srv/admin-service.js:2388-2447` — existing `listJobs` + `runJob` handlers
- `app/admin-shell/webapp/view/Board.view.xml:82-122` — Cron health panel
- `app/admin-shell/webapp/controller/Board.controller.js:133-173` — `onRunJob`/`_callRunJob` pattern
- `test/hybrid/cron-service-schedule.test.js:40-54` — opaque-outbox test precedent
- `docs/developers/operations/content-rollback.md` — runbook style template
- `docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md` — #958 CAP 10 scheduler migration
