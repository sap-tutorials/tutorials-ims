sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageBox",
  "sap/ui/core/BusyIndicator"
], function (Controller, MessageBox, BusyIndicator) {
  "use strict";
  return Controller.extend("sap.tutorials.admin.shell.controller.Statistics", {
    onInit: function () {},

    _getEventId: function () {
      return parseInt(this.byId("eventIdInput").getValue(), 10);
    },

    _downloadContent: function (content, filename) {
      var blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
      var link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      link.click();
    },

    onExportTaskRecords: function () {
      var eventId = this._getEventId();
      if (!eventId) { MessageBox.warning("Enter an Event ID"); return; }
      var format = this.byId("formatSelect").getSelectedKey();
      var oModel = this.getOwnerComponent().getModel("admin");
      BusyIndicator.show(0);
      var oFunc = oModel.bindContext("/exportTaskRecords(...)");
      oFunc.setParameter("eventLegacyId", eventId);
      oFunc.setParameter("format", format);
      oFunc.execute().then(function () {
        var result = oFunc.getBoundContext().getObject();
        this._downloadContent(result.value, "task-records-" + eventId + "." + format);
        BusyIndicator.hide();
      }.bind(this)).catch(function (err) {
        BusyIndicator.hide();
        MessageBox.error("Export failed: " + err.message);
      });
    },

    onExportAwardMissions: function () {
      var eventId = this._getEventId();
      if (!eventId) { MessageBox.warning("Enter an Event ID"); return; }
      var oModel = this.getOwnerComponent().getModel("admin");
      BusyIndicator.show(0);
      var oFunc = oModel.bindContext("/exportAwardMissions(...)");
      oFunc.setParameter("eventLegacyId", eventId);
      oFunc.execute().then(function () {
        var result = oFunc.getBoundContext().getObject();
        this._downloadContent(result.value, "award-missions-" + eventId + ".csv");
        BusyIndicator.hide();
      }.bind(this)).catch(function (err) {
        BusyIndicator.hide();
        MessageBox.error("Export failed: " + err.message);
      });
    }
  });
});
