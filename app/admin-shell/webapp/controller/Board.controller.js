sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel"
], function (Controller, JSONModel) {
  "use strict";
  return Controller.extend("sap.tutorials.admin.shell.controller.Board", {
    onInit: function () {
      var oModel = new JSONModel({ totalTutorials: 0, upToDate: 0, needsReview: 0 });
      this.getView().setModel(oModel, "board");
      this._loadMetrics();
    },

    _loadMetrics: function () {
      var oAdminModel = this.getOwnerComponent().getModel("admin");
      var oListBinding = oAdminModel.bindList("/TutorialMeta");
      oListBinding.requestContexts(0, 9999).then(function (aContexts) {
        var iTotal = aContexts.length;
        var now = new Date();
        var sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
        var iUpToDate = aContexts.filter(function (ctx) {
          var reviewed = ctx.getProperty("reviewedDate");
          return reviewed && new Date(reviewed) > sixMonthsAgo;
        }).length;
        this.getView().getModel("board").setData({
          totalTutorials: iTotal,
          upToDate: iUpToDate,
          needsReview: iTotal - iUpToDate
        });
      }.bind(this));
    }
  });
});
