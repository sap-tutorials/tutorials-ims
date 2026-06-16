sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension",
  "sap/ui/model/json/JSONModel",
  // AMD shim from Task 7 — isomorphic ESM merge helper exposed as a UI5 module.
  "sap/tutorials/admin/missions/ext/merge-branch-perf-amd"
], function (ControllerExtension, JSONModel, mergeBranchPerfMod) {
  "use strict";

  var mergeBranchPerf = mergeBranchPerfMod.mergeBranchPerf;

  return ControllerExtension.extend("sap.tutorials.admin.missions.ext.BranchAnalyticsHandler", {
    override: {
      onInit: function () {
        // Empty model up front so the visible-binding doesn't crash on first paint.
        this.base.getView().setModel(new JSONModel([]), "branchPerf");
      },
      // Fiori Elements v4 canonical lifecycle hook — fires every time the OP
      // re-binds to a new context (initial nav, cross-mission nav, refresh).
      // Per recon-confirmed FE v4 docs this is the right place to hang
      // per-context data fetches; attachPageReady / dataReceived fishing is
      // not needed.
      routing: {
        onAfterBinding: function (oContext) {
          if (!oContext) return;
          var that = this;
          oContext.requestObject("slug").then(function (sSlug) {
            if (!sSlug) return;
            that._loadBranchPerformance(sSlug);
          });
        }
      }
    },

    _loadBranchPerformance: function (sSlug) {
      var sFilter = encodeURIComponent("missionSlug eq '" + sSlug.replace(/'/g, "''") + "'");
      var sUrl  = "/admin/analytics/AnalyticsBranchPerformance?$filter=" + sFilter + "&$top=200";
      var sUrl2 = "/admin/analytics/AnalyticsBranchTopPick?$filter="     + sFilter + "&$top=400";
      var oModel = this.base.getView().getModel("branchPerf");
      Promise.all([
        fetch(sUrl,  { credentials: "include", headers: { Accept: "application/json" } }).then(function (r) { return r.json(); }),
        fetch(sUrl2, { credentials: "include", headers: { Accept: "application/json" } }).then(function (r) { return r.json(); })
      ]).then(function (parts) {
        var perf = (parts[0] && parts[0].value) || [];
        var top  = (parts[1] && parts[1].value) || [];
        oModel.setData(mergeBranchPerf(perf, top));
      }).catch(function () {
        // Silent on failure — section just shows the IllustratedMessage no-data state.
      });
    }
  });
});
