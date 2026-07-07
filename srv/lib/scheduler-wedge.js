// srv/lib/scheduler-wedge.js
//
// #1021: shared helpers for CAP 10 outbox-wedge recovery.
//
// The scheduler's belt-and-suspenders (runWithLock finally block),
// AdminService.JobControls.listJobs (wedge detection), and
// AdminService.JobControls.forceUnwedge (operator recovery) all reach
// into cds.outbox.Messages through this module.
//
// All access goes through cds.entities('cds.outbox').Messages + CQL —
// never hardcoded CDS_OUTBOX_MESSAGES column names.
//
// ─────────────────────────────────────────────────────────────────────
// Real column semantics (CAP 10.x, verified against DEV HANA 2026-07-07)
// ─────────────────────────────────────────────────────────────────────
// Reference: node_modules/@sap/cds/libx/queue/{consts.js,index.js}.
//
//   - target: the literal string `'queue'` for every scheduled task.
//     NOT `cron.<jobName>` (that's the emitted EVENT name, which lives
//     in the JSON `msg` payload, not on the column). The initial
//     implementation of this module filtered on `cron.<jobName>` and
//     therefore matched nothing in production — the wedge badge and
//     Force-unwedge button never rendered.
//
//   - task: the `.as(<name>)` name from `srv.schedule(...).as(name)` —
//     this is where the job name actually lives on the row.
//
//   - status: `NULL` initially; UPDATE'd to 'processing' when the row
//     is picked up (see queue/index.js:185); DELETE'd on success
//     (queue/index.js:266); attempts++ on failure. A row with status
//     NULL is simply a pending future tick — NOT stuck.
//
//   - lastAttemptTimestamp: NULL until the first process attempt. So
//     for actual stuck rows (status='processing') this is always set.
//     Older code preferred lastAttemptTimestamp, falling back to
//     timestamp; retained here for safety, though status='processing'
//     without lastAttemptTimestamp shouldn't happen in practice.
//
// ─────────────────────────────────────────────────────────────────────
// Fail-open contract
// ─────────────────────────────────────────────────────────────────────
// Every function catches ALL errors and returns a benign "no wedge"
// default. A missing entity, DB fault, or parse failure never surfaces
// as a false-positive wedge indicator, and never fails a scheduled tick.
//
// Refresh procedure: run `cds bind --exec -- node scripts/probe-outbox-shape.mjs`
// against real HANA after every CAP major bump. The unit tests here
// enforce the CURRENT shape; if CAP flips column semantics again, the
// probe surfaces the drift before it goes silent in production.

import cds from '@sap/cds';
import { CronExpressionParser } from 'cron-parser';

const LOG = cds.log('scheduler-wedge');

// #1021 (2026-07-07 refresh): hard floor on staleness. A row that has
// been 'processing' for longer than this is considered wedged regardless
// of the job's cron period. Prevents daily/weekly/monthly jobs from
// hiding a wedge for hours-to-days waiting for the cron iterator to
// declare a period elapsed. 60 minutes covers every real scheduled job
// in this project by a wide margin (the longest legitimate run is
// extractConcepts at ~40 min) while surfacing an actual stall promptly.
const STALE_FLOOR_MS = 60 * 60 * 1000;

/**
 * Delete a stuck outbox row for a given cron job, if any exists.
 *
 * Guarded to only match rows that have already been picked up
 * (status='processing') so a pending future-scheduled row (status=NULL)
 * is never accidentally deleted — deleting one of THOSE would break
 * the cron entirely until the next scheduler boot re-inserts it.
 *
 * Called from runWithLock's finally block (belt-and-suspenders on every
 * tick) and from AdminService.JobControls.forceUnwedge (operator recovery).
 *
 * @param {string} jobName
 * @returns {Promise<boolean>} true iff a row was actually deleted
 */
export async function deleteStuckOutboxRow(jobName) {
  try {
    const outbox = cds.entities('cds.outbox');
    if (!outbox?.Messages) return false;
    const db = await cds.connect.to('db');
    // Real filter: task = jobName AND status = 'processing'. The
    // target='queue' constraint is redundant with status='processing'
    // for the scheduling path but kept explicit — belt-and-suspenders
    // against a future CAP release that reuses status='processing' on
    // a non-queue target.
    const result = await db.run(
      DELETE.from(outbox.Messages).where({
        target: 'queue',
        task: jobName,
        status: 'processing',
      })
    );
    // CAP returns either a number (affected rows) or an object with
    // affectedRows depending on adapter — normalize.
    const affected = typeof result === 'number'
      ? result
      : (result?.affectedRows ?? 0);
    return affected > 0;
  } catch (err) {
    LOG.warn(`deleteStuckOutboxRow(${jobName}) failed: ${err.message}`);
    return false;
  }
}

/**
 * Load a Map of jobName → Date for every cron job with a `processing`
 * row in cds.outbox.Messages. The Date is the row's start timestamp
 * (lastAttemptTimestamp, falling back to timestamp). Reads broadly
 * (all rows) and filters in JS to survive column-name casing drift
 * between CAP releases and HANA/SQLite adapters.
 *
 * Rows without a usable timestamp are skipped — a stuck row without a
 * timestamp cannot be aged, so treat it as not-stale (fail-open).
 *
 * @returns {Promise<Map<string, Date>>}
 */
export async function loadStuckOutboxTargets() {
  const stuck = new Map();
  try {
    const outbox = cds.entities('cds.outbox');
    if (!outbox?.Messages) return stuck;
    const db = await cds.connect.to('db');
    const rows = await db.run(SELECT.from(outbox.Messages));
    for (const row of rows) {
      const status = row.status ?? row.STATUS;
      // Only rows that have been picked up. status=NULL means pending
      // future firing — perfectly healthy, must never be flagged.
      if (status !== 'processing') continue;

      const task = row.task ?? row.TASK;
      if (typeof task !== 'string' || task.length === 0) continue;

      // Prefer lastAttemptTimestamp; fall back to timestamp. Cover both
      // casings — HANA returns uppercase in some code paths, SQLite
      // preserves the CDS lowercase.
      const rawTs = row.lastAttemptTimestamp
        ?? row.LASTATTEMPTTIMESTAMP
        ?? row.timestamp
        ?? row.TIMESTAMP;
      if (!rawTs) continue;
      const rowDate = rawTs instanceof Date ? rawTs : new Date(rawTs);
      if (isNaN(rowDate.getTime())) continue;
      stuck.set(task, rowDate);
    }
  } catch (err) {
    LOG.warn(`loadStuckOutboxTargets failed: ${err.message}`);
  }
  return stuck;
}

/**
 * Returns true iff the outbox row is stale enough to be considered
 * wedged. A row is stale when EITHER:
 *
 *   (a) `now` has passed the next scheduled firing after the row's
 *       start timestamp — the row outlived a full tick interval, or
 *
 *   (b) the row has been in flight for more than STALE_FLOOR_MS
 *       (60 min), regardless of cron period.
 *
 * Rule (b) is #1021's 2026-07-07 refresh: without it, daily jobs
 * (e.g. `'13 2 * * *'`) would hide a wedge for almost a full 24h
 * because rule (a) requires the NEXT firing to have passed. That
 * defeats the point of surfacing wedges to operators. Weekly and
 * monthly jobs would be even worse.
 *
 * Fail-open: parse failure returns false (assume healthy — don't
 * false-positive wedges just because a cron expression is unusual).
 *
 * @param {string} cronExpr
 * @param {Date}   rowStartedAt  — when the outbox row was picked up
 * @param {Date}   now
 * @returns {boolean}  true = stale (wedged); false = healthy or unknown
 */
export function isRowStale(cronExpr, rowStartedAt, now) {
  // Rule (b) first — cheap and doesn't depend on cron parsing. Also
  // gives the correct answer when the cron expression is unparseable
  // (rule (a) would return false in that case, hiding a real wedge).
  const ageMs = now.getTime() - rowStartedAt.getTime();
  if (ageMs >= STALE_FLOOR_MS) return true;

  // Rule (a) — for jobs with sub-hour periods, catch wedges as soon
  // as a tick is missed even if we're inside the STALE_FLOOR_MS window.
  try {
    const iter = CronExpressionParser.parse(cronExpr, { tz: 'UTC', currentDate: rowStartedAt });
    const nextFiring = iter.next().toDate();
    return now >= nextFiring;
  } catch {
    return false; // fail-open: parse failure → rely on rule (b) only
  }
}

// Test seam — allow unit tests to observe the floor without exporting a mutable const.
export const _STALE_FLOOR_MS_FOR_TESTS = STALE_FLOOR_MS;
