# Scheduler troubleshooting — outbox wedges

When a CAP 10 scheduled job stops firing without any error surfacing, it's almost always an outbox wedge: a `cds.outbox.Messages` row stuck at `status='processing'` blocks the framework from firing subsequent ticks for that jobName.

> **Three distinct "stuck job" failure modes.** Diagnose which before acting — they live in different tables and have different fixes.
> 1. **Outbox wedge** (blocks future ticks for ONE job) — a `cds.outbox.Messages` row stuck at `status='processing'`. Fix: Force-unwedge (deletes the one row).
> 2. **Orphaned `PipelineLog` row** — a job shows **RUNNING forever** on the health board while still rescheduling normally; left by a process death mid-run (deploy/crash). See [Orphaned RUNNING PipelineLog rows](#orphaned-running-pipelinelog-rows-1293). Fix: boot reconciler / Force-close.
> 3. **Queue-processor stall** (**ALL** jobs overdue at once) — the shared CronService queue stops draining and high-frequency job rows drop out of the outbox entirely. A plain unwedge/delete does **NOT** fix this. See [All jobs overdue — queue-processor stall](#all-jobs-overdue--queue-processor-stall). Fix: **rolling `cf restart` of `tutorials-srv`**.

## When to use this

- The Cron health panel at `/admin-ui/#board` shows a red **Wedged** badge for a job.
- A job's `Last success` column has not advanced past its expected next fire time and there's no matching red error either.
- No `PipelineLog` rows with `pipelineType='SCHEDULED_JOB'` appear at the expected cadence for a specific job.

## When NOT to use this

- The job ran and failed with an error — fix the underlying cause and click **Run now**. The wedge path is for stuck rows, not failed runs.
- The job is legitimately still running (long-running jobs like Louvain community detection can take minutes). Compare `startedAt` on the RUNNING `PipelineLog` row to the job's expected duration before assuming a wedge.

## How the wedge happens

CAP 10's Scheduling API uses `srv.schedule(...).as(jobName)` as a status-column singleton lock: a `cds.outbox.Messages` row with `status='processing'` prevents concurrent scheduled ticks across CF instances. The framework normally flips the row's status back after the handler resolves.

If the handler throws *synchronously* before that flip — the classic case is a top-of-function precondition (missing config, unavailable dependency) — the row is left at `status='processing'` and CAP refuses to fire subsequent ticks for that jobName. Nothing lands in `JobLastRun`, nothing lands in `PipelineLog`. The failure is silent until someone notices the downstream effect.

Two defenses are in place after #1021:

1. **Belt-and-suspenders in `runWithLock`** — every tick DELETEs its own outbox row in the `finally` block, so a future synchronous throw still leaves the outbox clean.
2. **`forceUnwedge` UI** — when belt-and-suspenders wasn't in place yet (or the DELETE itself failed), operators can clear the wedge from the Cron health panel.

### Wedge detection thresholds

A row is flagged as wedged when **both** of the following are true:

- The row has `target='queue'`, `task=<jobName>`, `status='processing'` on `cds.outbox.Messages`. (Real column semantics — the `target` column is the literal string `'queue'`, not `cron.<jobName>`. The job name lives in the `task` column, populated by `srv.schedule(...).as(jobName)`.)
- The row has been in flight for **more than 60 minutes** OR its own next-scheduled-fire has already passed.

The 60-minute hard floor (added 2026-07-07) exists so daily / weekly / monthly jobs don't hide a wedge for hours-to-days waiting for the cron iterator to declare a period elapsed. It's larger than the longest legitimate scheduled run in this project (extractConcepts, ~40 min).

## Runbook

### 1. Confirm the wedge

Open `/admin-ui/#board`. Scroll to the **Cron health** panel. Look for red **Wedged** badges in the **Outbox** column.

If a job shows Wedged, note its `jobName` — you'll need it in step 2.

### 2. Force-unwedge from the UI

Click the **Force unwedge** button next to Run now on the wedged row. A confirmation dialog opens:

> Force-unwedge '`<jobName>`'? This deletes the stuck outbox row. The next scheduled tick will fire normally.

Click OK. Expect a green MessageToast:

> Unwedged '`<jobName>`'

The Wedged badge disappears. The row's `Next run` column already shows when the next scheduled tick will fire.

### 3. (Optional) Manually trigger a run

If you can't wait for the next scheduled tick, click **Run now** on the same row. The job runs immediately (bypasses the outbox — manual triggers use `setImmediate` per `srv/jobs/scheduler.js:20-25`).

### 4. Verify recovery

Wait for the next scheduled tick (or the manual run to finish). The `Last success` column should advance. No red badge should reappear on the following tick.

If the Wedged badge reappears, the underlying cause is recurring (handler still throwing synchronously). Check `cf logs tutorials-srv --recent` for the actual exception, fix that, and repeat step 2.

## HANA escape hatch (last resort)

If the admin UI is unreachable (approuter down, XSUAA outage), clear the wedge directly against HANA:

```bash
cds bind --exec -- hana-cli execute \
  "DELETE FROM CDS_OUTBOX_MESSAGES WHERE TASK='<jobName>' AND STATUS='processing'"
```

Or via `hdbsql`:

```sql
DELETE FROM CDS_OUTBOX_MESSAGES WHERE TASK='<jobName>' AND STATUS='processing';
```

**Note:** `CDS_OUTBOX_MESSAGES` is a CAP framework-owned table. Field names (`TASK`, `STATUS`) may change in a future CAP major release. Prefer the UI path; the SQL is a fallback for infrastructure outages, not routine operations.

## Orphaned RUNNING PipelineLog rows (#1293)

A **different** failure mode that also surfaces as "job stuck" on the Cron health board — but it does **not** block future ticks, and the outbox is clean.

### How it happens

`srv/jobs/scheduler.js:runWithLock` writes a `PipelineLog` row at `status='RUNNING'` *before* invoking a job's fn, and flips it to `SUCCESS`/`FAILED` in a `finally` block afterward. If the srv **process dies** mid-run — a deploy restart, a crash, a `cf stop` — that `finally` never executes. The row is orphaned at `RUNNING` with `finishedAt=NULL` forever. The health board's Status column then renders the job as **RUNNING** indefinitely, even though it's idle and rescheduling normally.

This is **not** an outbox wedge. The #1021 belt-and-suspenders cleans the `cds.outbox.Messages` row; it does nothing for the `PipelineLog` row (different table). And a process death bypasses both the `try/catch` and the `finally` that the belt lives in.

### How to tell it apart from an outbox wedge

- **Outbox wedge:** `SELECT COUNT(*) FROM CDS_OUTBOX_MESSAGES WHERE STATUS='processing'` — if **> 0** for the job, it's a wedge (future ticks blocked). The **Outbox** column shows a red **Wedged** badge.
- **Orphaned PipelineLog row:** outbox count is **0**, `JobLastRun` keeps advancing, and the job still fires on schedule — but the **Status** column shows **RUNNING** and never clears. `SELECT ID, TO_VARCHAR(STARTEDAT), METADATA FROM COM_SAP_DEVELOPERS_IMS_PIPELINELOG WHERE STATUS='RUNNING' AND PIPELINETYPE='SCHEDULED_JOB'` — a `STARTEDAT` matching a past deploy/restart window is the tell. (jobName lives in `METADATA` JSON, not a column.)

### Automatic recovery — boot reconciler

Since #1293, `CronService.init()` runs `reconcileOrphanedRunningJobs()` once at every srv boot. It flips any `SCHEDULED_JOB` + `RUNNING` `PipelineLog` row whose `startedAt` is older than a **60-minute floor** (mirrors the outbox wedge floor) to `FAILED`, stamping `errorDetails='interrupted by restart'`. So after any deploy/restart that interrupted a job, the next boot closes the orphan automatically — no operator action needed.

The 60-minute age gate exists so a genuinely long-running job on another CF instance (< floor) is never prematurely marked FAILED. It's larger than the longest legitimate scheduled run in this project (extractConcepts, ~40 min).

### Manual recovery — Force close

For the case where you don't want to wait for a restart (or the row is younger than the floor and you're certain it's orphaned), click the **Force close** button on the wedged row's **Trigger** column. It appears only when a job has been RUNNING past the 60-minute floor. A confirmation dialog opens:

> Force-close '`<jobName>`'? This marks the stuck RUNNING log row as FAILED. Use only if the job is not actually running (e.g. left over from a deploy or crash).

Click OK. The row flips to `FAILED` (no age gate on this path — the operator has decided), the Status column clears, and the button disappears. Backed by `AdminService.JobControls.forceClose(jobName)`, sibling to `forceUnwedge`, emitting a SecurityEvent audit with `outcome='force-closed'`.

### HANA escape hatch (last resort)

```sql
UPDATE COM_SAP_DEVELOPERS_IMS_PIPELINELOG
  SET STATUS='FAILED', FINISHEDAT=CURRENT_TIMESTAMP
  WHERE STATUS='RUNNING' AND PIPELINETYPE='SCHEDULED_JOB' AND ID='<rowId>';
```

## All jobs overdue — queue-processor stall

The most severe mode: **every** scheduled job shows stale/overdue on `/admin-ui/#board` at once, none dispatch, yet **manual Run-now still works**. First observed in PROD on 2026-10-12.

### How to recognise it

- The board shows **all** (not one) jobs overdue — `Last success` stale across the board, next-fire times in the past.
- Manual **Run now** works for every job (manual triggers use `setImmediate` and bypass the outbox entirely — `srv/jobs/scheduler.js`).
- `SELECT COUNT(*) FROM CDS_OUTBOX_MESSAGES WHERE STATUS='processing'` may be **0 or 1** — this mode is **not** diagnosed by the processing count alone.
- The tell is **missing rows**: high-frequency jobs (`metrics-rollup` `*/5`, `kg-ondemand-drain` `*/2`, `community-blogs-classify`, `publish-stuck-manifest-watchdog`) have **no `cds.outbox.Messages` row at all** — not `processing`, not `NULL`, absent. Compare the live outbox against `registerJobs()` in `srv/jobs/scheduler.js`.

> **Reminder on normal outbox state.** CAP keeps **one future-fire row per job** at `target='queue'`. `STATUS=NULL` is a healthy pending tick; on success the row is DELETE'd and the next future row inserted. A full healthy fleet shows ~1 NULL row per registered job (~54 at time of writing) and **0** processing. A job with **no row** is the anomaly.

### How it happens

CAP 10's `CronService` drives all scheduled jobs through **one shared outbox queue**. If the queue **processor** stalls (e.g. after a batch operator **Force-close** of several jobs, which closes the `PipelineLog` row but does not reconcile the outbox control state — see [follow-up](#open-follow-up)), two things go wrong together:

1. A singleton row can be left at `status='processing'`, and
2. jobs that were mid-cycle get their row **consumed but never re-inserted** — so they silently drop out of the schedule.

Deleting the stuck `processing` row (Force-unwedge / the HANA escape hatch above) clears the lock but **cannot resurrect the dropped rows** — per `srv/lib/scheduler-wedge.js`, a deleted schedule row is only re-created "until the next scheduler boot re-inserts it". And the stalled processor may still be running on an un-restarted CF instance.

### Recovery — rolling restart

A **rolling restart of `tutorials-srv`** is the fix. On boot, `CronService.init()` re-runs `schedule().every().as()` for every registered job, re-seeding all outbox rows; `reconcileOrphanedRunningJobs()` cleans up orphans.

```bash
cf target                              # MUST confirm space=prod before touching PROD
cf app tutorials-srv                   # note instance count (PROD runs 2)

# Rolling, one instance at a time — keeps one instance serving throughout:
cf restart-app-instance tutorials-srv 0
# wait until #0 is 'running' and healthy, then:
cf restart-app-instance tutorials-srv 1
```

**Restart ALL instances.** The 2026-10-12 incident showed that restarting only instance #0 re-seeded the outbox rows but ticks still did not drain — the stalled processor was on the un-restarted instance #1. The schedule did not fully recover until **both** instances had been restarted. If in doubt, `cf restart tutorials-srv` (rolling across all instances).

### Verify recovery (do not skip)

Confirm jobs actually **execute**, not just that rows reappear:

```sql
-- new SCHEDULED_JOB runs since the restart timestamp — expect SUCCESS rows for */2 and */5 jobs within a few minutes
SELECT TO_VARCHAR(STARTEDAT), STATUS, METADATA
  FROM COM_SAP_DEVELOPERS_IMS_PIPELINELOG
  WHERE PIPELINETYPE='SCHEDULED_JOB' AND STARTEDAT >= '<restart-time-UTC>'
  ORDER BY STARTEDAT DESC;
```

`kg-ondemand-drain` (every 2 min) and `metrics-rollup` (every 5 min) are the fastest signals — a couple of SUCCESS rows for those within ~5 minutes confirms the queue is draining.

### Open follow-up

Batch **Force-close** (`#1293`) closes `PipelineLog` rows but does not reconcile the shared outbox, which is what stranded the `processing` row AND dropped the high-frequency rows in the 2026-10-12 incident. Candidate hardening (track via DEV PR): have `forceClose` also clear/re-arm the affected outbox rows, or codify "force-close N jobs → restart srv" so operators don't hit this. The existing `forceUnwedge` single-row delete is **insufficient** for this mode by design.

## References

- Incident: PROD scheduler stall 2026-10-12 — all jobs overdue after a batch Force-close; recovered by clearing one `processing` row + rolling `cf restart tutorials-srv`.
- Issue: [#1021](https://github.com/sap-tutorials/tutorials-ims/issues/1021) — this fix
- Issue: [#1022](https://github.com/sap-tutorials/tutorials-ims/issues/1022) — upstream CAP hook (in progress)
- Issue: [#1293](https://github.com/sap-tutorials/tutorials-ims/issues/1293) — orphaned RUNNING PipelineLog reconciler + Force close
- Code: `srv/jobs/scheduler.js:runWithLock` — belt-and-suspenders
- Code: `srv/lib/scheduler-wedge.js` — helpers (`deleteStuckOutboxRow`, `loadStuckOutboxTargets`)
- Code: `srv/lib/pipeline-log-reconciler.js` — orphaned-row reconciler (`reconcileOrphanedRunningJobs`, `forceCloseRunningPipelineLog`)
- Design: `docs/superpowers/specs/2026-07-06-1021-outbox-wedge-design.md`
