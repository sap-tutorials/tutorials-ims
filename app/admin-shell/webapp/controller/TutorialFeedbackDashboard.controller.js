sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel"
], function (Controller, JSONModel) {
  "use strict";
  return Controller.extend("sap.tutorials.admin.shell.controller.TutorialFeedbackDashboard", {
    onInit: function () {
      var oModel = new JSONModel({
        totalResponses: 0,
        avgNps90d: 0,
        avgOverall: 0,
        pctAuthenticated: 0,
        aggregates: [],
        recentComments: []
      });
      this.getView().setModel(oModel);
      this._refresh();
    },

    _refresh: async function () {
      var oModel = this.getView().getModel();
      var since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
      try {
        var aggRes = await fetch('/admin/TutorialFeedbackAggregate');
        var rawRes90d = await fetch('/admin/TutorialFeedback?$filter=submittedAt ge ' + since + '&$select=npsScore');
        var recentRes = await fetch('/admin/TutorialFeedback?$orderby=submittedAt desc&$top=10&$filter=comment ne null');

        var agg = ((await aggRes.json()).value) || [];
        var npsRows = ((await rawRes90d.json()).value) || [];
        var recent = ((await recentRes.json()).value) || [];

        oModel.setProperty('/aggregates', agg);
        oModel.setProperty('/recentComments', recent);

        var totalResponses = agg.reduce(function (s, r) { return s + (r.responseCount || 0); }, 0);
        var totalAuthenticated = agg.reduce(function (s, r) { return s + (r.authenticatedCount || 0); }, 0);
        oModel.setProperty('/totalResponses', totalResponses);

        var npsValid = npsRows.filter(function (r) { return r.npsScore != null; });
        oModel.setProperty('/avgNps90d', npsValid.length
          ? (npsValid.reduce(function (s, r) { return s + r.npsScore; }, 0) / npsValid.length).toFixed(1)
          : 0);

        oModel.setProperty('/avgOverall', agg.length
          ? (agg.reduce(function (s, r) { return s + Number(r.avgUseCase || 0); }, 0) / agg.length).toFixed(1)
          : 0);

        oModel.setProperty('/pctAuthenticated', totalResponses
          ? Math.round(100 * totalAuthenticated / totalResponses)
          : 0);
      } catch (e) {
        // Network or parse error — leave defaults so the view still renders.
      }
    },

    onRowPress: function (oEvent) {
      var slug = oEvent.getSource().getBindingContext().getProperty('tutorialSlug');
      var escaped = String(slug).replace(/'/g, "''");
      this.getOwnerComponent().getRouter().navTo('feedbackList', {
        '?query': { '$filter': "tutorialSlug eq '" + escaped + "'" }
      });
    },

    onOpenList: function () {
      this.getOwnerComponent().getRouter().navTo('feedbackList');
    }
  });
});
