// app/admin-shell/webapp/controller/job-controls-sort.js
//
// #750: pure sort helper. Applied to the JOIN output of
// JobControlsHelpers.joinJobsWithLastRuns() before the JSONModel write
// in Board.controller.js _loadJobControls(). Chronological order
// (nextRunIso ascending) surfaces what's about to fire at the top of
// the table; jobs with no upcoming run (null nextRunIso — e.g. a bad
// schedule that log-warned out of the handler) sort to the bottom.
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

  return { sortJobsByNextRun: sortJobsByNextRun };
});
