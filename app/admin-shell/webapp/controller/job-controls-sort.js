// app/admin-shell/webapp/controller/job-controls-sort.js
//
// #750: pure sort helper. Applied to the JOIN output of
// JobControlsHelpers.joinJobsWithLastRuns() before the JSONModel write
// in Board.controller.js _loadJobControls(). Chronological order
// (nextRunIso ascending) surfaces what's about to fire at the top of
// the table; jobs with no upcoming run (null nextRunIso — e.g. a bad
// schedule that log-warned out of the handler) sort to the bottom.
//
// #2488: also exposes sortJobsByName (alphabetical) and a sortJobs
// dispatcher so the operator can re-sort the Cron health table by name
// or date from the panel header without a server round-trip.
//
// Unit-tested in test/unit/admin-shell/job-controls-sort.test.js.

sap.ui.define([], function () {
  'use strict';

  /**
   * Sort a list of joined job rows by nextRunIso ascending. Stable —
   * equal timestamps preserve input order. Null / undefined / invalid
   * timestamps sort to the bottom.
   *
   * Returns a new array; does NOT mutate the input.
   *
   * @param {Array<{jobName: string, nextRunIso?: string|null}>} jobs
   * @returns {Array<object>}
   */
  function sortJobsByNextRun(jobs) {
    // Decorate with original index so the comparator can fall back to it
    // for stable ordering across ties (Array.prototype.sort is stable in
    // V8 11+ which UI5 targets, but the explicit fallback also handles
    // null-vs-null comparisons consistently).
    var decorated = (jobs || []).map(function (j, i) {
      var t = (j && j.nextRunIso) ? Date.parse(j.nextRunIso) : NaN;
      return { job: j, idx: i, t: isNaN(t) ? Infinity : t };
    });
    decorated.sort(function (a, b) {
      if (a.t !== b.t) return a.t - b.t;
      return a.idx - b.idx;
    });
    return decorated.map(function (d) { return d.job; });
  }

  /**
   * #2488: Sort a list of joined job rows alphabetically by jobName,
   * case-insensitive, ascending. Stable — equal names preserve input
   * order. Missing / non-string jobName sorts to the bottom.
   *
   * Returns a new array; does NOT mutate the input.
   *
   * @param {Array<{jobName?: string}>} jobs
   * @returns {Array<object>}
   */
  function sortJobsByName(jobs) {
    var decorated = (jobs || []).map(function (j, i) {
      var name = (j && typeof j.jobName === 'string') ? j.jobName : null;
      return { job: j, idx: i, name: name };
    });
    decorated.sort(function (a, b) {
      // Nameless rows sort to the bottom, preserving relative order.
      if (a.name === null && b.name === null) return a.idx - b.idx;
      if (a.name === null) return 1;
      if (b.name === null) return -1;
      var cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      if (cmp !== 0) return cmp;
      return a.idx - b.idx;
    });
    return decorated.map(function (d) { return d.job; });
  }

  /**
   * #2488: Dispatch to the requested sort. 'name' → alphabetical by
   * jobName; 'date' (default / anything else) → chronological by
   * nextRunIso. Keeps Board.controller.js free of comparator logic.
   *
   * @param {Array<object>} jobs
   * @param {string} [key] - 'name' or 'date'
   * @returns {Array<object>}
   */
  function sortJobs(jobs, key) {
    return key === 'name' ? sortJobsByName(jobs) : sortJobsByNextRun(jobs);
  }

  return {
    sortJobsByNextRun: sortJobsByNextRun,
    sortJobsByName: sortJobsByName,
    sortJobs: sortJobs
  };
});
