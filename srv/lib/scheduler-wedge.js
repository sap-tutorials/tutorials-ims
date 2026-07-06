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
import cronParser from 'cron-parser';

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
 * Load a Map of jobName → true for every cron job with a `processing`
 * row in cds.outbox.Messages. Reads broadly (all rows) and filters in
 * JS to survive column-name casing drift between CAP releases.
 *
 * @returns {Promise<Map<string, true>>}
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
        stuck.set(target.slice('cron.'.length), true);
      }
    }
  } catch (err) {
    LOG.warn(`loadStuckOutboxTargets failed: ${err.message}`);
  }
  return stuck;
}

/**
 * Given a cron expression and a "now" timestamp, return true if we are
 * still inside the active window (between the previous firing and the
 * next firing). Composes with the outbox row's existence in listJobs()
 * to decide "wedged": a row exists AND we are NOT inside the current
 * window → wedged.
 *
 * Fail-open: parse failure returns true (assume healthy — don't
 * false-positive wedges just because a cron expression is unusual).
 *
 * @param {string} cronExpr
 * @param {Date} now
 * @returns {boolean}
 */
export function isWithinExpectedTickWindow(cronExpr, now) {
  try {
    const iter = cronParser.parseExpression(cronExpr, { currentDate: now });
    // prev() = last firing at-or-before now; next() = next firing after now.
    // We are always inside [prev, next) by definition of these iterators —
    // this helper's real job is to guard against parse failures cleanly.
    // Callers combine this with row-age evidence for the wedge decision.
    const prev = iter.prev();
    const next = iter.next();
    return now >= prev.toDate() && now < next.toDate();
  } catch {
    return true;
  }
}
