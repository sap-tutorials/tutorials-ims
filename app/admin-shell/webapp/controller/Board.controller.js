sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/tutorials/admin/shell/controller/job-controls-helpers",
  "sap/tutorials/admin/shell/controller/job-controls-sort",
  "sap/tutorials/admin/shell/controller/cron-timeline-helpers"
], function (Controller, JSONModel, MessageToast, MessageBox, JobControlsHelpers, JobControlsSort, CronTimelineHelpers) {
  "use strict";
  return Controller.extend("sap.tutorials.admin.shell.controller.Board", {
    onInit: function () {
      var oModel = new JSONModel({
        totalUsers: 0,
        totalTutorials: 0,
        totalGroups: 0,
        totalMissions: 0,
        avgTutorialCompletion: 0,
        avgGroupCompletion: 0,
        avgMissionCompletion: 0,
        tutorialsUpToDate: 0,
        tutorialsNeedReview: 0,
        reviewPercentage: 0
      });
      this.getView().setModel(oModel, "board");
      // #756: empty JSONModel for the Cron health tile; populated by
      // _loadJobControls() once the OData JOIN resolves.
      // #750: timelineHtml drives the <core:HTML> ribbon control. Empty
      // string until _loadJobControls() resolves; never null (UI5 HTML
      // control treats null as "use the previous content").
      this.getView().setModel(new JSONModel({ jobs: [], timelineHtml: '' }), "jobControls");
      this._loadMetrics();
      this._loadJobControls();
    },

    onExit: function () {
      // #756: clean up the post-trigger poll if the view is destroyed before
      // the 5-min budget elapses.
      if (this._jobControlsPollHandle) {
        clearInterval(this._jobControlsPollHandle);
        this._jobControlsPollHandle = null;
      }
    },

    _loadMetrics: function () {
      var oAdminModel = this.getOwnerComponent().getModel("admin");
      var oContext = oAdminModel.bindContext("/getBoardStatistics(...)");
      oContext.execute().then(function () {
        var oResult = oContext.getBoundContext().getObject();
        var iTotal = (oResult.tutorialsUpToDate || 0) + (oResult.tutorialsNeedReview || 0);
        var iPercentage = iTotal > 0 ? Math.round((oResult.tutorialsUpToDate / iTotal) * 100) : 0;
        this.getView().getModel("board").setData({
          totalUsers: oResult.totalUsers || 0,
          totalTutorials: oResult.totalTutorials || 0,
          totalGroups: oResult.totalGroups || 0,
          totalMissions: oResult.totalMissions || 0,
          avgTutorialCompletion: oResult.avgTutorialCompletion || 0,
          avgGroupCompletion: oResult.avgGroupCompletion || 0,
          avgMissionCompletion: oResult.avgMissionCompletion || 0,
          tutorialsUpToDate: oResult.tutorialsUpToDate || 0,
          tutorialsNeedReview: oResult.tutorialsNeedReview || 0,
          reviewPercentage: iPercentage
        });
      }.bind(this));
    },

    /**
     * #756: fetch listJobs() + JobLastRun, JOIN client-side via the helper,
     * and push the result onto the 'jobControls' JSONModel. Best-effort —
     * a failure renders an empty tile but doesn't block the rest of the
     * Board.
     */
    _loadJobControls: function () {
      var oAdminModel = this.getOwnerComponent().getModel("admin");
      var oJobControlsModel = this.getView().getModel("jobControls");
      var that = this;
      return Promise.all([
        this._callListJobs(oAdminModel),
        this._loadJobLastRunRows(oAdminModel)
      ]).then(function (results) {
        var aJobs = results[0];
        var aLastRuns = results[1];
        var aJoined = JobControlsHelpers.joinJobsWithLastRuns(aJobs, aLastRuns);
        // #750: chronological sort (nextRunIso ascending, nulls last) so the
        // table reads top-to-bottom as "soonest first."
        var aSorted = JobControlsSort.sortJobsByNextRun(aJoined);
        // #750: build the SVG ribbon from the same array.
        var sTimelineHtml = CronTimelineHelpers.buildTimelineSvg(aSorted, {
          now: new Date(),
          widthPx: 800,
          heightPx: 80
        });
        oJobControlsModel.setProperty("/jobs", aSorted);
        oJobControlsModel.setProperty("/timelineHtml", sTimelineHtml);
      }).catch(function (err) {
        // Best-effort — the tile renders 0 rows, the rest of the Board still works.
        // eslint-disable-next-line no-console
        console.warn("_loadJobControls failed:", err && err.message ? err.message : err);
        that._lastJobControlsError = err;
      });
    },

    /**
     * #756: invoke AdminService.JobControls.listJobs(). Returns array of
     * {jobName, schedule, ttlMs, description, nextRunIso}. Bound to the
     * JobControls singleton, so the path is /JobControls/AdminService.listJobs(...).
     */
    _callListJobs: function (oAdminModel) {
      var oAction = oAdminModel.bindContext("/JobControls/AdminService.listJobs(...)");
      return oAction.execute().then(function () {
        var oResult = oAction.getBoundContext().getObject();
        if (!oResult) return [];
        // OData v4 returns the collection under `value` for a bound action
        // that returns a collection; the bare object for a single entity.
        return Array.isArray(oResult) ? oResult : (oResult.value || []);
      });
    },

    /**
     * #756: read all JobLastRun rows (small table — ≤24 rows after pre-seed).
     */
    _loadJobLastRunRows: function (oAdminModel) {
      var oBinding = oAdminModel.bindList("/JobLastRun");
      return oBinding.requestContexts(0, 999).then(function (aCtxs) {
        return aCtxs.map(function (oCtx) { return oCtx.getObject(); });
      });
    },

    /**
     * #756: Run now button press handler. Optimistically sets isRunning,
     * invokes runJob, shows toast, schedules a 5-min poll for completion.
     */
    onRunJob: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("jobControls");
      var sJobName = oCtx.getProperty("jobName");
      var sPath = oCtx.getPath();
      var iIdx = parseInt(sPath.split("/").pop(), 10);
      var oModel = this.getView().getModel("jobControls");
      var that = this;

      // Optimistic UI — instant button busy spinner.
      oModel.setProperty("/jobs/" + iIdx + "/isRunning", true);

      return this._callRunJob(sJobName).then(function (oResult) {
        if (oResult && oResult.started) {
          MessageToast.show(sJobName + ": started");
          // Leave isRunning true; the post-trigger poll will refresh the
          // tile (which resets isRunning via the helper's JOIN default)
          // once the job finishes.
          that._scheduleJobControlsRefresh();
        } else {
          var sReason = (oResult && oResult.reason) ? oResult.reason : "skipped";
          MessageToast.show(sJobName + ": " + sReason);
          oModel.setProperty("/jobs/" + iIdx + "/isRunning", false);
        }
      }).catch(function (err) {
        MessageBox.error("Failed to start " + sJobName + ": " + (err && err.message ? err.message : String(err)));
        oModel.setProperty("/jobs/" + iIdx + "/isRunning", false);
      });
    },

    /**
     * #756: invoke AdminService.JobControls.runJob(jobName). Bound to the
     * JobControls singleton, fire-and-forget on the server side.
     */
    _callRunJob: function (sJobName) {
      var oAdminModel = this.getOwnerComponent().getModel("admin");
      var oAction = oAdminModel.bindContext("/JobControls/AdminService.runJob(...)");
      oAction.setParameter("jobName", sJobName);
      return oAction.execute().then(function () {
        return oAction.getBoundContext().getObject();
      });
    },

    /**
     * #756: poll JobLastRun every 30 s for the next 5 min after a manual
     * trigger. Stops automatically when 5 min elapses. Re-entrant — if a
     * second trigger lands while polling is in flight, the existing schedule
     * is reused.
     */
    _scheduleJobControlsRefresh: function () {
      if (this._jobControlsPollHandle) return;  // already polling
      var iElapsed = 0;
      var POLL_INTERVAL_MS = 30000;
      var POLL_MAX_MS = 5 * 60 * 1000;
      var that = this;
      this._jobControlsPollHandle = setInterval(function () {
        iElapsed += POLL_INTERVAL_MS;
        try {
          that._loadJobControls();
        } catch (err) {
          // ignore — best-effort poll
        }
        if (iElapsed >= POLL_MAX_MS) {
          clearInterval(that._jobControlsPollHandle);
          that._jobControlsPollHandle = null;
        }
      }, POLL_INTERVAL_MS);
    },

    /**
     * #756: UI formatters bound from Board.view.xml's Cron health Table.
     * Thin delegates to job-controls-helpers so the formatter logic stays
     * unit-testable.
     */
    formatNextRun: function (iso) { return JobControlsHelpers.formatNextRun(iso); },
    formatRelativeTime: function (iso) { return JobControlsHelpers.formatRelativeTime(iso); }
  });
});
