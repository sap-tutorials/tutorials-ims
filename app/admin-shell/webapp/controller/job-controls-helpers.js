// app/admin-shell/webapp/controller/job-controls-helpers.js
//
// Pure-function helpers extracted from Board.controller.js for testability.
// The Board controller methods stay thin wrappers around these. UI5 controller
// methods are not unit-testable outside the OPA5 / qunit harness, so the JOIN
// logic + formatters that drive the Cron health tile's listJobs + JobLastRun
// extension live here and are exercised by vitest from
// test/unit/admin-shell/board-controller-job-controls.test.js.
//
// The file is structured as a UI5 module (`sap.ui.define`). The vitest test
// loads the same file via raw-source eval with a stubbed `sap.ui.define`
// (see top of the test file) so the same source serves both runtimes.

sap.ui.define([], function () {
  'use strict';

  /**
   * JOIN listJobs output with JobLastRun rows AND listRunningJobs by jobName.
   * Both inputs are plain arrays of objects; output is a flat array suitable
   * for setting on a JSONModel at '/jobs'.
   *
   * runningNow (#1023) is the server-authoritative list of jobs currently
   * executing (PipelineLog rows with status='RUNNING'). A job appearing here
   * is marked isRunning:true regardless of last-known-failed state — running
   * trumps last-completed, because "manually retriggered and still executing"
   * must not display as the prior failure.
   *
   * @param {Array<{jobName, schedule, ttlMs, description, nextRunIso, nextRunsIso?}>} jobs
   * @param {Array<{jobName, lastSuccessAt?, lastErrorAt?, lastErrorMessage?}>} lastRuns
   * @param {Array<{jobName, startedAt}>} [runningNow]
   * @returns {Array<object>}
   */
  function joinJobsWithLastRuns(jobs, lastRuns, runningNow) {
    var byName = new Map((lastRuns || []).map(function (r) { return [r.jobName, r]; }));
    var byRunning = new Map((runningNow || []).map(function (r) { return [r.jobName, r]; }));
    var now = Date.now();
    return (jobs || []).map(function (j) {
      var hit = byName.get(j.jobName);
      var runHit = byRunning.get(j.jobName);
      var joined = Object.assign({}, j, {
        lastSuccessAt: hit && hit.lastSuccessAt != null ? hit.lastSuccessAt : null,
        lastErrorAt: hit && hit.lastErrorAt != null ? hit.lastErrorAt : null,
        lastErrorMessage: hit && hit.lastErrorMessage != null ? hit.lastErrorMessage : null,
        isRunning: !!runHit,
        runningSince: runHit && runHit.startedAt != null ? runHit.startedAt : null,
      });
      var status = classifyJobStatus(joined, now);
      joined.statusLabel = status.statusLabel;
      joined.statusState = status.statusState;
      return joined;
    });
  }

  /**
   * Categorize a job's live state for the Cron health tile's Status column.
   *
   * RUNNING (Information / blue) — job is currently executing, per
   *   listRunningJobs. Trumps everything: a re-triggered job that had
   *   previously failed must not display the old error while running.
   * NEVER (None / grey) — no success and no error recorded yet.
   * FAILED (Error / red) — most recent completion was a failure.
   * STALE (Warning / yellow) — last success older than 2× the estimated
   *   schedule interval. Interval is estimated from nextRunsIso[1] -
   *   nextRunsIso[0] when ≥2 firings fall in the next 24h window;
   *   otherwise defaults to 24 h. Monthly crons keep the 24 h default,
   *   which effectively disables STALE for them — acceptable trade-off,
   *   monthly jobs get their own explicit review.
   * OK (Success / green) — last completion was a success and within
   *   2× interval.
   *
   * Kept as a standalone function (not inlined in joinJobsWithLastRuns) so
   * the classification is unit-testable in isolation and can be reused if
   * we ever surface the same categorical elsewhere.
   *
   * @param {{isRunning:boolean, lastSuccessAt?:string, lastErrorAt?:string, nextRunsIso?:Array<string>}} job
   * @param {number} [now=Date.now()]
   * @returns {{statusLabel:string, statusState:string}}
   */
  function classifyJobStatus(job, now) {
    if (now == null) now = Date.now();
    if (job.isRunning) return { statusLabel: 'RUNNING', statusState: 'Information' };
    var hasSuccess = job.lastSuccessAt != null;
    var hasError = job.lastErrorAt != null;
    if (!hasSuccess && !hasError) return { statusLabel: 'NEVER', statusState: 'None' };
    var successMs = hasSuccess ? new Date(job.lastSuccessAt).getTime() : 0;
    var errorMs = hasError ? new Date(job.lastErrorAt).getTime() : 0;
    if (errorMs > successMs) return { statusLabel: 'FAILED', statusState: 'Error' };
    // Estimate cadence from adjacent nextRunsIso entries. Default 24h.
    var intervalMs = 24 * 3600 * 1000;
    var runs = Array.isArray(job.nextRunsIso) ? job.nextRunsIso : [];
    if (runs.length >= 2) {
      var t0 = new Date(runs[0]).getTime();
      var t1 = new Date(runs[1]).getTime();
      if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) {
        intervalMs = t1 - t0;
      }
    }
    if (successMs && (now - successMs) > 2 * intervalMs) {
      return { statusLabel: 'STALE', statusState: 'Warning' };
    }
    return { statusLabel: 'OK', statusState: 'Success' };
  }

  /**
   * Humanize a running-since ISO into an "elapsed" duration (#1023) —
   * "5m 23s", "1h 2m", "42s". Returns '' for null/invalid so the view
   * binding can render an empty tooltip when the job isn't running.
   *
   * @param {string|null|undefined} iso
   * @returns {string}
   */
  function formatElapsedSince(iso) {
    if (!iso) return '';
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    var diffMs = Date.now() - date.getTime();
    if (diffMs < 0) return '';
    var totalSec = Math.floor(diffMs / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  /**
   * Humanize an ISO timestamp into "in N hours" (< 24h away) OR
   * "Day HH:MM UTC" (>= 24h away) OR "overdue" (past) OR "—" (null / invalid).
   *
   * @param {string|null|undefined} iso
   * @returns {string}
   */
  function formatNextRun(iso) {
    if (!iso) return '—';
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    var diffMs = date.getTime() - Date.now();
    if (diffMs < 0) return 'overdue';
    var diffHrs = Math.round(diffMs / 3600000);
    if (diffHrs < 24) {
      return diffHrs === 0 ? 'in <1 hour' : 'in ' + diffHrs + ' hour' + (diffHrs === 1 ? '' : 's');
    }
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return days[date.getUTCDay()] + ' ' + pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes()) + ' UTC';
  }

  /**
   * Humanize an ISO timestamp into "N minutes ago" / "N hours ago" /
   * "N days ago" / "just now" / "Never" (null / invalid).
   *
   * @param {string|null|undefined} iso
   * @returns {string}
   */
  function formatRelativeTime(iso) {
    if (!iso) return 'Never';
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return 'Never';
    var diffMs = Date.now() - date.getTime();
    if (diffMs < 0) return 'just now';
    var mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' minute' + (mins === 1 ? '' : 's') + ' ago';
    var hrs = Math.round(diffMs / 3600000);
    if (hrs < 24) return hrs + ' hour' + (hrs === 1 ? '' : 's') + ' ago';
    var days2 = Math.round(diffMs / 86400000);
    return days2 + ' day' + (days2 === 1 ? '' : 's') + ' ago';
  }

  return {
    joinJobsWithLastRuns: joinJobsWithLastRuns,
    classifyJobStatus: classifyJobStatus,
    formatNextRun: formatNextRun,
    formatRelativeTime: formatRelativeTime,
    formatElapsedSince: formatElapsedSince,
  };
});
