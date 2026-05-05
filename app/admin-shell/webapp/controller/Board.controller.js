sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel"
], function (Controller, JSONModel) {
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
      this._loadMetrics();
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
    }
  });
});
