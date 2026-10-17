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

### How it happens (root cause — #2782)

CAP 10's `CronService` drives all scheduled jobs through **one shared outbox queue** (`cds.outbox.Messages`, `target='queue'`, one singleton row per job keyed on a deterministic ID). The next occurrence of an `.every()` job is **not** seeded at boot or on a timer — it is inserted **only when the current tick completes**, atomically with the delete of the current row (`@sap/cds/libx/queue/processing.js`). Crucially the lifecycle spans **two separate transactions**:

1. **Claim** — `UPDATE … SET status='processing'`, committed immediately. The payload is *only* `status`; `lastAttemptTimestamp` is **not** written here.
2. **Complete** — DELETE the current row **and** INSERT the next occurrence, in a *later* tx that wraps the entire handler runtime.

`lastAttemptTimestamp` is written **only** on the failed/retry branch — never on claim, never on success.

**The deploy trigger:** a blue-green cutover sends SIGTERM to the draining instance. If that lands *between* the two transactions (i.e. any time a job is mid-run — seconds to minutes), the row is left durably at `status='processing'` with `lastAttemptTimestamp` still **NULL**, and **no successor row** is ever inserted. CAP's own reclaim predicate is `(status IS NULL OR lastAttemptTimestamp < now-1h)` — a `processing` row with NULL `lastAttemptTimestamp` matches *neither* disjunct (`NULL < ?` is SQL UNKNOWN), so **CAP never reclaims it**. The job silently drops out of the schedule with **no error and no log line**, and survives restarts. This is the "consumed-but-not-reinserted" mode, and it reproduces on **every** deploy because every cutover SIGTERMs an instance that may be mid-tick.

> A `processing` row that *did* fail at least once has `lastAttemptTimestamp` set and **is** reclaimed by the built-in 1h lease — it's specifically the cutover-death row (never-failed, NULL `lastAttemptTimestamp`) that escapes the lease.

Deleting the stuck `processing` row (Force-unwedge / the HANA escape hatch above) clears that one lock but **cannot resurrect the dropped rows** — `forceUnwedge` only deletes, it doesn't re-seed. (A batch operator **Force-close** of several jobs can *also* strand a `processing` row, but that is a secondary path; the primary, every-deploy cause is the SIGTERM-mid-tick tombstone above.)

### Automatic recovery — outbox tombstone reaper (#2782)

Since #2782, every srv boot arms a **tombstone reaper** (`srv/lib/scheduler-reaper.js`, from `CronService.init()`). It targets the root cause directly: the NULL-`lastAttemptTimestamp` `processing` rows CAP's lease can never reclaim.

- **Boot sweep.** Right after init, a deferred `reapTombstonedOutboxRows()` pass clears any tombstone left by the instance that just cut over.
- **Periodic self-heal.** Every ~10 min (`SCHEDULER_SELFHEAL_INTERVAL_MS`) a single `.unref()`'d timer re-reaps — a tombstone can be created *after* an instance booted, which the boot sweep can't catch — **and** runs an **alert-only** canary check (`metrics-rollup` `*/5`, `kg-ondemand-drain` `*/2`): if **both** are stale past the grace window it raises a `SchedulerStallDetected` **ALERT**. There is **no `process.exit`** — the reaper is the recovery, the alert is just the signal.
- **What the reaper deletes.** Only rows at `status='processing'` that are genuinely **stale** per `scheduler-wedge.isRowStale` (the 60-min floor + cron-period rule). A legitimately long-running job (e.g. `extractConcepts` ~40 min) inside the floor is **never** reaped; a pending `status=NULL` future row is never touched. Deleting (rather than nulling status) lets the next `CronService.init()` `.every().as()` UPSERT — or the next healthy tick — re-seed a fresh future row; nulling status would instead make CAP immediately **retry** the dead row.
- **HANA-HA-failover fast path (#2814).** #2782's fast recovery assumed the tombstone always coincided with an app restart (blue-green cutover → boot sweep). A **HANA HA failover** (uptime patch / standby takeover) tombstones the same row **without** bouncing srv, so neither `init()` nor the boot sweep re-runs — leaving only the periodic reaper, which used to wait out the full 60-min floor (~70 min total stall). The reaper now cross-checks each stuck job's `PipelineLog` (`loadRunningScheduledJobNames`): a `processing` row whose job has **no RUNNING `SCHEDULED_JOB` `PipelineLog` row** is not actually in-flight, so it is reaped **regardless of age** (recovery within one ~10-min reaper tick, no manual restart). A row whose job **does** have a RUNNING `PipelineLog` row is protected at **any** age — even past the floor — so a genuinely long run is never reaped mid-flight. If both the outbox tombstone **and** an orphaned RUNNING `PipelineLog` row linger (a handler that died after writing its RUNNING row), the RUNNING row vetoes the fast path until `reconcileOrphanedRunningJobs` closes it at the 60-min floor — recovery then matches the pre-#2814 timing (no worse).
- **Fail-open throughout.** A missing entity, DB fault, or a single row's DELETE throwing never aborts the pass, never kills the timer, and never fails a scheduled tick. The #2814 `PipelineLog` lookup is fail-open too: if it can't be read it falls back to **floor-only** reaping — never reaps more aggressively on error. Enabled on CF, off locally (`SCHEDULER_HEALTHCHECK_ENABLED` overrides).
- **Replaces #2762.** The prior post-boot self-check `process.exit(1)`'d to force a CF reschedule. That did **not** durably recover the 2026-10-14 fleet — a restart can't clear a NULL-`lastAttemptTimestamp` tombstone, and re-running `init()` churns the outbox (deterministic-ID UPSERTs) on every bounce. The exit / per-instance stagger / crash-loop cooldown / self-restart marker machinery was removed; only the pure canary evaluator survives, now consumed by the reaper's alert-only tick.

- **Knobs** (default-safe): `SCHEDULER_HEALTHCHECK_ENABLED` (on in CF, off locally), `SCHEDULER_HEALTHCHECK_GRACE_MS` (default 6 min, canary staleness), `SCHEDULER_SELFHEAL_INTERVAL_MS` (default 10 min, reaper cadence).

If the `SchedulerStallDetected` alert fires but the board **still** shows all jobs overdue after a couple of reaper ticks, fall back to the manual rolling restart below.

### Recovery — rolling restart (manual)

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

### Resolved follow-up (#2782)

The earlier candidate hardening ("have `forceClose` also re-arm the affected outbox rows, or codify force-close-then-restart") is superseded by the **tombstone reaper** above, which clears the stranded `processing` rows automatically on boot and every ~10 min regardless of how they were stranded (SIGTERM mid-tick *or* batch Force-close). The `forceUnwedge` single-row delete remains available for manual operator use but is no longer the only line of defence.

## References

- Incident: PROD scheduler stall 2026-10-12 — all jobs overdue after a batch Force-close; recovered by clearing one `processing` row + rolling `cf restart tutorials-srv`.
- Issue: [#1021](https://github.com/sap-tutorials/tutorials-ims/issues/1021) — this fix
- Issue: [#1022](https://github.com/sap-tutorials/tutorials-ims/issues/1022) — upstream CAP hook (in progress)
- Issue: [#1293](https://github.com/sap-tutorials/tutorials-ims/issues/1293) — orphaned RUNNING PipelineLog reconciler + Force close
- Issue: [#2762](https://github.com/sap-tutorials/tutorials-ims/issues/2762) — post-boot scheduler-stall self-check + auto rolling-restart (blue-green stall); **superseded by #2782** (the self-restart didn't durably recover)
- Issue: [#2782](https://github.com/sap-tutorials/tutorials-ims/issues/2782) — outbox tombstone reaper: durable fix for the NULL-`lastAttemptTimestamp` `processing` row CAP's lease can't reclaim
- Issue: [#2814](https://github.com/sap-tutorials/tutorials-ims/issues/2814) — reaper PipelineLog cross-check: fast-recovers HANA-HA-failover tombstones (no app restart) via the RUNNING-row signal, bypassing the 60-min floor for jobs that aren't actually in-flight
- Code: `srv/jobs/scheduler.js:runWithLock` — belt-and-suspenders
- Code: `srv/lib/scheduler-wedge.js` — helpers (`deleteStuckOutboxRow`, `loadStuckOutboxTargets`)
- Code: `srv/lib/pipeline-log-reconciler.js` — orphaned-row reconciler (`reconcileOrphanedRunningJobs`, `forceCloseRunningPipelineLog`)
- Code: `srv/lib/scheduler-boot-healthcheck.js` — #2762 post-boot stall self-check (`scheduleBootHealthCheck`, `evaluateCanaries`)
- Design: `docs/superpowers/specs/2026-07-06-1021-outbox-wedge-design.md`
