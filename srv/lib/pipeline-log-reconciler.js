// srv/lib/pipeline-log-reconciler.js
//
// #1293: reconcile orphaned scheduled-job PipelineLog rows.
//
// ─────────────────────────────────────────────────────────────────────
// The problem
// ─────────────────────────────────────────────────────────────────────
// srv/jobs/scheduler.js:runWithLock writes a PipelineLog row at
// status='RUNNING' before invoking a job fn, and flips it to
// SUCCESS/FAILED in a finally block afterward. If the srv PROCESS dies
// mid-run (deploy restart, crash, `cf stop`), that finally never runs —
// the row is orphaned at RUNNING with finishedAt=null forever. The Cron
// health board (/admin-ui/#board) then renders the job as continuously
// running even though it's idle and rescheduling normally.
//
// This is NOT the #1021 outbox wedge. #1021 cleans a stuck
// cds.outbox.Messages row (blocks FUTURE ticks); this cleans the
// PipelineLog observability row (the health-tile record). The two live
// in different tables, and a process death bypasses both the try/catch
// AND the finally that #1021's belt-and-suspenders lives in.
//
// ─────────────────────────────────────────────────────────────────────
// The fix
// ─────────────────────────────────────────────────────────────────────
// reconcileOrphanedRunningJobs() runs ONCE at boot (from
// CronService.init, after model load). It flips any SCHEDULED_JOB +
// RUNNING row whose startedAt is older than RECONCILE_FLOOR_MS (60 min)
// to FAILED. A row younger than the floor may be a legitimately in-flight
// long job on another CF instance, so the age gate avoids racing genuine
// runs. The 60-min floor mirrors STALE_FLOOR_MS in scheduler-wedge.js —
// larger than the longest legitimate scheduled run in this project
// (extractConcepts, ~40 min).
//
// forceCloseRunningPipelineLog(jobName) is the manual operator path
// (sibling to AdminService.JobControls.forceUnwedge). It closes RUNNING
// rows for one named job with NO age gate — the operator has already
// decided the row is orphaned and clicked Force-close.
//
// ─────────────────────────────────────────────────────────────────────
// jobName matching
// ─────────────────────────────────────────────────────────────────────
// The jobName lives in the PipelineLog.metadata JSON string
// ({"jobName":"..."}), NOT in a column. We SELECT the candidate rows and
// parse metadata in JS — identical to listRunningJobs in
// srv/admin-service.js — so the code path is byte-identical across SQLite
// (unit tests) and HANA (hybrid + prod). No HANA JSON_VALUE.
//
// Fail-open contract: every function catches all errors and returns a
// benign {closed:0}. A DB fault at boot must never crash srv startup.

import cds from '@sap/cds';

const LOG = cds.log('pipeline-log-reconciler');

// #1293: age floor before a RUNNING scheduled-job row is presumed
// orphaned. Mirrors STALE_FLOOR_MS in scheduler-wedge.js (60 min).
const RECONCILE_FLOOR_MS = 60 * 60 * 1000;

const NS = 'com.sap.developers.ims';

/**
 * Close every SCHEDULED_JOB PipelineLog row stuck at RUNNING whose
 * startedAt is older than RECONCILE_FLOOR_MS. Flips status to FAILED,
 * sets finishedAt + durationMs, and stamps errorDetails.
 *
 * Runs once at boot. Fail-open: any error is logged and swallowed,
 * returning {closed:0} so srv startup never crashes.
 *
 * @returns {Promise<{closed: number}>}
 */
export async function reconcileOrphanedRunningJobs() {
  const now = Date.now();
  const floor = new Date(now - RECONCILE_FLOOR_MS).toISOString();
  return closeRunningRows({
    where: { pipelineType: 'SCHEDULED_JOB', status: 'RUNNING', startedAt: { '<': floor } },
    errorDetails: 'interrupted by restart (reconciled at boot #1293)',
    now,
  });
}

/**
 * Force-close RUNNING PipelineLog rows for one named scheduled job, with
 * NO age gate. The operator path (AdminService.JobControls.forceClose)
 * — the caller has already decided the row is orphaned.
 *
 * jobName is matched against PipelineLog.metadata JSON in JS (same as
 * listRunningJobs), not a SQL column, so it's adapter-agnostic.
 *
 * Fail-open: any error is logged and swallowed, returning {closed:0}.
 *
 * @param {string} jobName
 * @returns {Promise<{closed: number}>}
 */
export async function forceCloseRunningPipelineLog(jobName) {
  if (typeof jobName !== 'string' || jobName.length === 0) return { closed: 0 };
  return closeRunningRows({
    where: { pipelineType: 'SCHEDULED_JOB', status: 'RUNNING' },
    matchJobName: jobName,
    errorDetails: `force-closed by operator (#1293): '${jobName}'`,
    now: Date.now(),
  });
}

/**
 * Shared body: SELECT candidate RUNNING rows, optionally filter by
 * jobName (parsed from metadata JSON), then UPDATE each to FAILED.
 *
 * @param {{where: object, matchJobName?: string, errorDetails: string, now: number}} opts
 * @returns {Promise<{closed: number}>}
 */
async function closeRunningRows({ where, matchJobName, errorDetails, now }) {
  try {
    const { PipelineLog } = cds.entities(NS);
    const rows = await SELECT
      .from(PipelineLog)
      .columns('ID', 'startedAt', 'metadata')
      .where(where);

    let closed = 0;
    for (const row of rows || []) {
      // When a jobName filter is supplied, parse metadata and skip
      // non-matching rows. Unparseable metadata never matches.
      if (matchJobName != null) {
        const name = extractJobName(row.metadata);
        if (name !== matchJobName) continue;
      }
      const finishedAt = new Date(now).toISOString();
      const durationMs = row.startedAt
        ? now - new Date(row.startedAt).getTime()
        : null;
      await UPDATE(PipelineLog, row.ID).set({
        status: 'FAILED',
        finishedAt,
        durationMs,
        errorDetails,
      });
      closed++;
    }
    if (closed > 0) {
      LOG.warn(`closed ${closed} orphaned RUNNING scheduled-job PipelineLog row(s)`);
    }
    return { closed };
  } catch (err) {
    LOG.warn(`closeRunningRows failed: ${err.message ?? err}`);
    return { closed: 0 };
  }
}

/**
 * Extract jobName from a PipelineLog.metadata JSON string. Returns null
 * on missing/malformed metadata (matches listRunningJobs semantics).
 *
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

// Test seam — expose the floor without exporting a mutable const.
export const _RECONCILE_FLOOR_MS_FOR_TESTS = RECONCILE_FLOOR_MS;
