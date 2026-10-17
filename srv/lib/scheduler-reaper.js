// srv/lib/scheduler-reaper.js
//
// #2782: outbox tombstone reaper — the durable fix for the blue-green cutover
// scheduler stall. Replaces the #2762 process.exit self-restart (which could
// not clear these rows and churned the outbox on every restart).
//
// ─────────────────────────────────────────────────────────────────────
// Root cause (verified against @sap/cds@10.1 libx/queue/processing.js)
// ─────────────────────────────────────────────────────────────────────
// A CAP 10 scheduled tick runs in two separate transactions:
//   1. Claim (processing.js:222): UPDATE … SET { status:'processing' },
//      committed immediately. The set payload is ONLY `status` — it does
//      NOT write lastAttemptTimestamp.
//   2. Complete (processing.js:333 + :356-371): DELETE the current row and
//      INSERT the next `.every()` occurrence, in a LATER tx that wraps the
//      entire handler runtime.
// lastAttemptTimestamp is written ONLY in the failed/retry branch
// (processing.js:426) — never on claim, never on success.
//
// A SIGTERM between the two txs — exactly what a blue-green stop does to the
// draining instance — leaves the row durably at status='processing' with
// lastAttemptTimestamp STILL NULL, and no successor row. CAP's own reclaim
// predicate is `(status is NULL OR lastAttemptTimestamp < ?)` (processing.js:57):
//   - status is 'processing' → first disjunct false;
//   - lastAttemptTimestamp is NULL → `NULL < ?` is SQL UNKNOWN → false.
// Neither matches, so CAP never re-selects the row → permanent tombstone, no
// next tick ever scheduled → the job silently drops with NO error and NO log
// line. (A row that DID fail at least once has lastAttemptTimestamp set and is
// reclaimed by the 1h lease; the cutover-death row is the one that escapes it.)
//
// ─────────────────────────────────────────────────────────────────────
// What the reaper does
// ─────────────────────────────────────────────────────────────────────
// Find every cds.outbox.Messages row stuck at status='processing' and, for the
// ones that are genuinely STALE (per scheduler-wedge.isRowStale — same 60-min
// floor + cron-period rule the operator wedge badge uses), DELETE the row by
// ID. Deleting (not nulling status) is the right move: on the next
// CronService.init() the `.every().as()` UPSERT re-seeds a fresh future row,
// and even without a reboot the singleton re-seeds on the next healthy tick.
// Nulling status instead would make CAP immediately RETRY the dead row, re-
// running a job that was mid-flight when the instance died — worse.
//
// #2814: #2782 only fast-recovered the tombstone on an app restart (the
// blue-green cutover case). A HANA HA failover (uptime patch / standby
// takeover) strands the SAME row WITHOUT bouncing srv, so CronService.init()
// and its boot sweep never re-run — up to ~70 min of silent stall (60-min floor
// + one 10-min reaper interval). The reaper now cross-checks each stuck job's
// PipelineLog: a job with NO RUNNING SCHEDULED_JOB PipelineLog row is not
// actually in-flight, so its tombstone is reaped regardless of age (sub-floor
// fast path). A job WITH a RUNNING row is protected at any age — even past the
// floor — so genuinely long runs are never reaped mid-flight. See
// loadRunningScheduledJobNames.
//
// Fail-open throughout, matching scheduler-wedge.js: a missing entity, DB
// fault, or a single row's DELETE throwing never aborts the pass and never
// fails a scheduled tick. A legitimately long-running job (status='processing'
// but younger than the 60-min floor) is never reaped.

import cds from '@sap/cds';
import { isRowStale } from './scheduler-wedge.js';
import { evaluateCanaries, isHealthCheckEnabled, CANARY_JOBS, _DEFAULT_GRACE_MS } from './scheduler-boot-healthcheck.js';

const LOG = cds.log('scheduler-reaper');

const IMS_NS = 'com.sap.developers.ims';

/**
 * #2814: load the set of scheduled-job names that are genuinely in-flight RIGHT
 * NOW, per their PipelineLog RUNNING row. This is the authoritative "is the
 * handler actually running" signal — a status='processing' outbox row whose job
 * has NO RUNNING SCHEDULED_JOB PipelineLog row is a tombstone regardless of age
 * (the handler either never started or already died), so the 60-min stale floor
 * can be bypassed for it. A row whose job DOES have a RUNNING row is protected
 * at any age (a legitimately long run — e.g. extractConcepts ~40 min — must not
 * be reaped mid-flight).
 *
 * jobName lives in the PipelineLog.metadata JSON string ({"jobName":"..."}), NOT
 * a column — parsed in JS exactly like AdminService.listRunningJobs
 * (srv/admin-service.js) and pipeline-log-reconciler.closeRunningRows, so the
 * code path is byte-identical across SQLite (unit tests) and HANA (hybrid/prod).
 * No HANA JSON_VALUE.
 *
 * Fail-open with a SENTINEL: returns a Set on success (possibly empty = "nothing
 * is running, verified"), or `null` when the PipelineLog entity is missing or
 * the query faults ("could not determine"). The caller treats `null` as
 * inconclusive and falls back to the floor-only behaviour — it NEVER reaps more
 * aggressively on error. An empty Set is a positive answer and DOES enable the
 * fast path.
 *
 * @returns {Promise<Set<string>|null>} RUNNING job names, or null if undeterminable
 */
export async function loadRunningScheduledJobNames() {
  try {
    const { PipelineLog } = cds.entities(IMS_NS);
    if (!PipelineLog) return null;
    const rows = await SELECT
      .from(PipelineLog)
      .columns('metadata')
      .where({ pipelineType: 'SCHEDULED_JOB', status: 'RUNNING' });
    const running = new Set();
    for (const row of rows ?? []) {
      const name = extractJobName(row.metadata ?? row.METADATA);
      if (name) running.add(name);
    }
    return running;
  } catch (err) {
    LOG.warn(`loadRunningScheduledJobNames failed (treating as undeterminable → floor-only): ${err.message ?? err}`);
    return null;
  }
}

/**
 * Extract jobName from a PipelineLog.metadata JSON string. Returns null on
 * missing/malformed metadata — mirrors listRunningJobs / closeRunningRows.
 * @param {string|null|undefined} metadata
 * @returns {string|null}
 */
function extractJobName(metadata) {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed.jobName === 'string' ? parsed.jobName : null;
  } catch {
    return null;
  }
}

/**
 * Delete stale status='processing' outbox rows that CAP's 1h lease can never
 * reclaim (the NULL-lastAttemptTimestamp cutover tombstone). Idempotent and
 * safe to run on every instance: the DELETE is keyed on the row ID, and a row
 * already gone just affects 0 rows.
 *
 * #2814: before judging a row by the 60-min stale floor, cross-check its job's
 * PipelineLog RUNNING state (loadRunningScheduledJobNames). This closes the
 * HANA-HA-failover coverage hole (#2782 only fast-recovered on an app restart):
 *   - job has a RUNNING PipelineLog row  → NEVER reap (any age; protects genuine
 *     long runs even past the floor).
 *   - job provably NOT running (lookup OK, job absent) → reap regardless of age
 *     (the sub-floor fast path — a tombstone from a failover with no restart).
 *   - lookup undeterminable (null) → fall back to the floor-only behaviour
 *     (reap iff isRowStale) — never reaps more aggressively on error.
 *
 * @param {Map<string,string>} jobSchedules  jobName → cron expression, so each
 *   row's staleness is judged against its own cron period. A row whose job is
 *   not in the map (retired job, or map empty) is judged by the 60-min floor
 *   alone (isRowStale fail-opens on an undefined/unparseable cron).
 * @param {Date} [now=new Date()]
 * @returns {Promise<{inspected:number, reaped:number}>}
 *   inspected = processing rows examined; reaped = rows actually deleted.
 */
export async function reapTombstonedOutboxRows(jobSchedules, now = new Date()) {
  let inspected = 0;
  let reaped = 0;
  try {
    const outbox = cds.entities('cds.outbox');
    if (!outbox?.Messages) return { inspected, reaped };
    const db = await cds.connect.to('db');
    const rows = await db.run(SELECT.from(outbox.Messages));

    // #2814: one PipelineLog lookup per pass (not per-row) — cheap on the 10-min
    // timer. null = undeterminable → floor-only fallback below.
    const runningJobs = await loadRunningScheduledJobNames();

    for (const row of rows ?? []) {
      // Scope to the SCHEDULER queue only. cds.outbox.Messages is shared with
      // the persistent-outbox for emitted events (ANS alerts, cds.emit), which
      // also go through status='processing' but on a DIFFERENT target. Reaping
      // one of those would silently drop an event the outbox is still retrying.
      // Mirror deleteStuckOutboxRow's deliberate target='queue' constraint.
      const target = row.target ?? row.TARGET;
      if (target !== 'queue') continue;

      const status = row.status ?? row.STATUS;
      // Only picked-up rows. status=NULL is a healthy pending future tick.
      if (status !== 'processing') continue;

      const task = row.task ?? row.TASK;
      if (typeof task !== 'string' || task.length === 0) continue;

      const id = row.ID ?? row.id;
      if (id == null) continue;

      inspected++;

      // Age the row from lastAttemptTimestamp if present, else the fire-time
      // `timestamp`. On the cutover-death path lastAttemptTimestamp is NULL,
      // so `timestamp` (set at row creation) is what dates the tombstone.
      const rawTs = row.lastAttemptTimestamp
        ?? row.LASTATTEMPTTIMESTAMP
        ?? row.timestamp
        ?? row.TIMESTAMP;
      if (!rawTs) continue; // can't age it → leave it (fail-open)
      const rowStartedAt = rawTs instanceof Date ? rawTs : new Date(rawTs);
      if (isNaN(rowStartedAt.getTime())) continue;

      const cronExpr = jobSchedules?.get?.(task);
      const stale = isRowStale(cronExpr, rowStartedAt, now);

      // #2814 decision. runningJobs is a Set on a successful PipelineLog lookup,
      // or null when undeterminable.
      //   - provablyRunning (Set has task) → NEVER reap, any age (genuine run).
      //   - lookup OK + task absent        → reap, any age (fast path, incl.
      //                                       sub-floor failover tombstone).
      //   - lookup null (undeterminable)   → floor-only: reap iff stale.
      let fastPath = false;
      if (runningJobs instanceof Set) {
        if (runningJobs.has(task)) continue; // genuine in-flight run → protect
        fastPath = !stale;                   // not running + inside floor → fast-path reap
      } else if (!stale) {
        continue; // undeterminable + inside floor → keep the floor (fail-open)
      }

      // Reap it. Per-row try/catch so one failing DELETE doesn't abort the
      // whole sweep.
      try {
        await db.run(DELETE.from(outbox.Messages).where({ ID: id }));
        reaped++;
        LOG.warn(
          `reaped tombstoned outbox row for job '${task}' (ID ${id}, status=processing, ` +
          `started ${rowStartedAt.toISOString()})` +
          (fastPath
            ? ` — no RUNNING PipelineLog, reaped inside the 60-min floor (#2814 HANA-failover fast path)`
            : ` — CAP's 1h lease could not reclaim it`)
        );
      } catch (err) {
        LOG.warn(`reap DELETE for job '${task}' (ID ${id}) failed: ${err.message ?? err}`);
      }
    }
  } catch (err) {
    LOG.warn(`reapTombstonedOutboxRows failed (treating as no-op): ${err.message ?? err}`);
  }
  return { inspected, reaped };
}

// Default self-heal interval: 10 min. Long enough that the reaper's SELECT over
// cds.outbox.Messages (~54 rows) is negligible load; short enough that a
// tombstone created AFTER an instance booted (so its own boot sweep missed it)
// is cleared well inside the window operators would otherwise notice on the
// board. .unref()'d so it never keeps the process alive.
export const _DEFAULT_SELFHEAL_INTERVAL_MS = 10 * 60 * 1000;

function selfHealIntervalFromEnv(env = process.env) {
  const v = Number.parseInt(env.SCHEDULER_SELFHEAL_INTERVAL_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : _DEFAULT_SELFHEAL_INTERVAL_MS;
}

/**
 * Read the canary JobLastRun rows for the alert-only stall check. Fail-open:
 * any error → [] (evaluateCanaries then reports healthy).
 */
async function loadCanaryRows() {
  try {
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const db = await cds.connect.to('db');
    const rows = await db.run(
      SELECT.from(JobLastRun).columns('jobName', 'lastSuccessAt').where({ jobName: { in: CANARY_JOBS } })
    );
    return rows || [];
  } catch (err) {
    LOG.warn(`loadCanaryRows failed (treating as healthy): ${err.message ?? err}`);
    return [];
  }
}

/**
 * Arm the periodic scheduler self-heal (#2782). A single .unref()'d interval
 * timer that, on every tick:
 *   1. runs reapTombstonedOutboxRows() to clear NULL-lastAttemptTimestamp
 *      outbox tombstones CAP's lease can't reclaim, and
 *   2. runs the #2762 canary check (metrics-rollup / kg-ondemand-drain) and, if
 *      BOTH are stale, raises a SchedulerStallDetected ALERT — ALERT-ONLY, no
 *      process.exit (the reaper is the recovery; the alert is just the signal).
 *
 * No-op (returns null) when disabled (off CF, or SCHEDULER_HEALTHCHECK_ENABLED
 * =false). Fully fail-open: a tick never throws, so a transient DB fault can't
 * crash the process or kill the timer. Dependencies are injectable for tests.
 *
 * @param {object} [opts]
 * @param {Record<string,string|undefined>} [opts.env=process.env]
 * @param {Map<string,string>} opts.jobSchedules  jobName → cron, passed to the reaper
 * @param {(fn:Function, ms:number)=>any} [opts.setIntervalFn=setInterval]
 * @param {(schedules:Map, now?:Date)=>Promise<{inspected:number,reaped:number}>} [opts.reap=reapTombstonedOutboxRows]
 * @param {()=>Promise<Array>} [opts.loadRows=loadCanaryRows]
 * @param {(input:object)=>Promise<unknown>} [opts.raiseAlert]
 * @param {number} [opts.graceMs]
 * @returns {any|null} the timer handle (unref'd), or null when disabled
 */
export function armSchedulerSelfHeal(opts = {}) {
  const env = opts.env ?? process.env;
  if (!isHealthCheckEnabled(env)) {
    LOG.info('scheduler self-heal disabled (not on CF / explicitly off)');
    return null;
  }

  const intervalMs = selfHealIntervalFromEnv(env);
  const graceMs = Number.parseInt(env.SCHEDULER_HEALTHCHECK_GRACE_MS, 10) > 0
    ? Number.parseInt(env.SCHEDULER_HEALTHCHECK_GRACE_MS, 10)
    : (opts.graceMs ?? _DEFAULT_GRACE_MS);
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const jobSchedules = opts.jobSchedules ?? new Map();
  const reap = opts.reap ?? reapTombstonedOutboxRows;
  const loadRows = opts.loadRows ?? loadCanaryRows;
  const raiseAlert = opts.raiseAlert ?? (async (input) => {
    const alerting = await import('./alerting.js');
    return alerting.raise(input);
  });

  const tick = async () => {
    // 1. Reap tombstones (primary recovery). Fail-open — never let a reap
    //    fault skip the canary check or throw out of the timer.
    try {
      const { inspected, reaped } = await reap(jobSchedules, new Date());
      if (reaped > 0) {
        LOG.warn(`scheduler self-heal reaped ${reaped} outbox tombstone(s) (inspected ${inspected} processing row(s))`);
      }
    } catch (err) {
      LOG.warn(`scheduler self-heal reap tick failed (ignored): ${err.message ?? err}`);
    }

    // 2. Alert-only canary check. If both canaries are stale, the queue is
    //    stalled in a way the reap may not have cleared this tick (e.g. the
    //    tombstone is younger than the 60-min floor, or the stall is a
    //    different mode) — surface it to operators. No exit.
    try {
      const rows = await loadRows();
      const verdict = evaluateCanaries(rows, new Date(), graceMs);
      if (verdict.stalled) {
        const instanceIndex = env.CF_INSTANCE_INDEX ?? '?';
        LOG.error(`#2782 scheduler stall signal on instance ${instanceIndex}: ${verdict.reason} — raising ALERT (reaper is primary recovery; no self-exit)`);
        await raiseAlert({
          eventType: 'SchedulerStallDetected',
          severity: 'ERROR',
          category: 'ALERT',
          subject: `Scheduler stall signal on instance ${instanceIndex} — both canaries stale`,
          body:
            `Both high-frequency canary jobs (${CANARY_JOBS.join(', ')}) are stale past the ${Math.round(graceMs / 60000)}m grace ` +
            `on instance ${instanceIndex} (${verdict.reason}). The outbox-tombstone reaper runs on this same tick and clears the ` +
            `NULL-lastAttemptTimestamp rows CAP's lease cannot reclaim. If the board STILL shows all jobs overdue after a couple of ` +
            `reaper ticks, do a rolling restart of BOTH instances. ` +
            `Runbook: docs/developers/operations/scheduler-troubleshooting.md § "All jobs overdue — queue-processor stall".`,
          resource: { resourceName: 'cron-service-queue', resourceType: 'scheduler' },
        });
      }
    } catch (err) {
      LOG.warn(`scheduler self-heal canary tick failed (ignored): ${err.message ?? err}`);
    }
  };

  LOG.info(`scheduler self-heal armed: every ${Math.round(intervalMs / 60000)}m (reaper + alert-only canary check) on instance ${env.CF_INSTANCE_INDEX ?? '?'}`);
  const handle = setIntervalFn(tick, intervalMs);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}
