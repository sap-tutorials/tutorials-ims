# Scheduler troubleshooting — outbox wedges

When a CAP 10 scheduled job stops firing without any error surfacing, it's almost always an outbox wedge: a `cds.outbox.Messages` row stuck at `status='processing'` blocks the framework from firing subsequent ticks for that jobName.

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

## References

- Issue: [#1021](https://github.com/sap-tutorials/tutorials-ims/issues/1021) — this fix
- Issue: [#1022](https://github.com/sap-tutorials/tutorials-ims/issues/1022) — upstream CAP hook (in progress)
- Code: `srv/jobs/scheduler.js:runWithLock` — belt-and-suspenders
- Code: `srv/lib/scheduler-wedge.js` — helpers (`deleteStuckOutboxRow`, `loadStuckOutboxTargets`)
- Design: `docs/superpowers/specs/2026-07-06-1021-outbox-wedge-design.md`
