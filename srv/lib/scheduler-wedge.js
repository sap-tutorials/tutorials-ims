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
// never hardcoded CDS_OUTBOX_MESSAGES column names. Column names
// confirmed via scripts/probe-outbox-shape.mjs (2026-07-06, CAP 10.x):
//   - target (String) — event name, format `cron.<jobName>` for scheduled jobs
//   - status (String) — 'processing' when a row is picked up
//
// Fail-open contract: every function catches ALL errors and returns a
// benign "no wedge" default. A missing entity, DB fault, or parse
// failure never surfaces as a false-positive wedge indicator.

import cds from '@sap/cds';
import { CronExpressionParser } from 'cron-parser';

const LOG = cds.log('scheduler-wedge');

/**
 * Delete the stuck outbox row for a given cron job, if any.
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
    const result = await db.run(
      DELETE.from(outbox.Messages).where({ target: `cron.${jobName}` })
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
 * row in cds.outbox.Messages. The Date is the row's own start timestamp
 * (lastAttemptTimestamp, falling back to timestamp). Reads broadly (all
 * rows) and filters in JS to survive column-name casing drift between
 * CAP releases.
 *
 * Rows without a usable timestamp are skipped — missing timestamps are
 * treated as "not stale" (fail-open).
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
      const target = row.target ?? row.TARGET;
      if (status === 'processing'
          && typeof target === 'string'
          && target.startsWith('cron.')) {
        // Prefer lastAttemptTimestamp; fall back to timestamp.
        // Both may arrive uppercase on HANA — cover all casings.
        const rawTs = row.lastAttemptTimestamp
          ?? row.LASTATTEMPTTIMESTAMP
          ?? row.timestamp
          ?? row.TIMESTAMP;
        if (!rawTs) continue; // missing timestamp → skip (fail-open)
        const rowDate = rawTs instanceof Date ? rawTs : new Date(rawTs);
        if (isNaN(rowDate.getTime())) continue; // unparseable → skip
        stuck.set(target.slice('cron.'.length), rowDate);
      }
    }
  } catch (err) {
    LOG.warn(`loadStuckOutboxTargets failed: ${err.message}`);
  }
  return stuck;
}

/**
 * Returns true iff `now` has passed the next scheduled firing after the
 * stuck outbox row's own start timestamp (`rowStartedAt`). This is the
 * wedge criterion: the row survived past the tick that should have
 * replaced it.
 *
 * Fail-open: parse failure returns false (assume healthy — don't
 * false-positive wedges just because a cron expression is unusual).
 *
 * @param {string} cronExpr
 * @param {Date}   rowStartedAt  — when the outbox row was created
 * @param {Date}   now
 * @returns {boolean}  true = stale (wedged); false = healthy or unknown
 */
export function isRowStale(cronExpr, rowStartedAt, now) {
  try {
    // Anchor the iterator at rowStartedAt, then advance to the NEXT firing
    // after that timestamp. If now has reached or passed that firing, the
    // row has outlived a full tick interval — it is stale/wedged.
    const iter = CronExpressionParser.parse(cronExpr, { tz: 'UTC', currentDate: rowStartedAt });
    const nextFiring = iter.next().toDate();
    return now >= nextFiring;
  } catch {
    return false; // fail-open: parse failure → not stale
  }
}
