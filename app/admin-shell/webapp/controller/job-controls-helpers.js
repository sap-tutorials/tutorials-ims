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
   * JOIN listJobs output with JobLastRun rows by jobName.
   * Both inputs are plain arrays of objects; output is a flat array suitable
   * for setting on a JSONModel at '/jobs'.
   *
   * @param {Array<{jobName, schedule, ttlMs, description, nextRunIso}>} jobs
   * @param {Array<{jobName, lastSuccessAt?, lastErrorAt?, lastErrorMessage?}>} lastRuns
   * @returns {Array<object>}
   */
  function joinJobsWithLastRuns(jobs, lastRuns) {
    var byName = new Map((lastRuns || []).map(function (r) { return [r.jobName, r]; }));
    return (jobs || []).map(function (j) {
      var hit = byName.get(j.jobName);
      return Object.assign({}, j, {
        lastSuccessAt: hit && hit.lastSuccessAt != null ? hit.lastSuccessAt : null,
        lastErrorAt: hit && hit.lastErrorAt != null ? hit.lastErrorAt : null,
        lastErrorMessage: hit && hit.lastErrorMessage != null ? hit.lastErrorMessage : null,
        isRunning: false,
      });
    });
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
    formatNextRun: formatNextRun,
    formatRelativeTime: formatRelativeTime,
  };
});
