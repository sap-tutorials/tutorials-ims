// srv/lib/cron-firings.js — pure-function helpers that enumerate cron
// firings within a time window. Powers the nextRunsIso field on
// AdminService.JobControls.listJobs() (#750), which the Board's Cron
// health tile uses to render the chronological sort + Next-3-runs
// column + 24-hour SVG timeline ribbon.
//
// Uses the same cron-parser v5 API already used by srv/admin-service.js:2166
// — CronExpressionParser.parse(schedule, { tz, currentDate }). Keeping the
// option shape symmetric across both call sites means any future v5 → v6
// upgrade is a single grep, not two.

import { CronExpressionParser } from 'cron-parser';

/**
 * Enumerate cron firings within a time window.
 * @param {string} schedule  Cron expression (5-field, matches node-cron).
 * @param {Date} from        Window start (exclusive — `from` itself is not a firing).
 * @param {Date} to          Window end (inclusive — strictly `>` is the exit condition).
 * @param {number} cap       Hard limit on returned timestamps.
 * @returns {string[]}       ISO timestamp strings (UTC), oldest to newest.
 */
export function enumerateFiringsWithinWindow(schedule, from, to, cap) {
  const iter = CronExpressionParser.parse(schedule, { tz: 'UTC', currentDate: from });
  const out = [];
  while (out.length < cap) {
    const next = iter.next().toDate();
    if (next > to) break;
    out.push(next.toISOString());
  }
  return out;
}

/**
 * Single-firing convenience: the next time `schedule` fires after `from`.
 * Used by the listJobs handler as fallback for jobs whose next firing is
 * outside the 24h window enumerated by enumerateFiringsWithinWindow() —
 * monthly crons like `23 4 1 * *` where nextRunsIso is [] but we still
 * want to surface the next firing in the per-row Next run column.
 *
 * @param {string} schedule
 * @param {Date} from
 * @returns {string}
 */
export function nextRunIsoFrom(schedule, from) {
  return CronExpressionParser.parse(schedule, { tz: 'UTC', currentDate: from })
    .next().toDate().toISOString();
}
