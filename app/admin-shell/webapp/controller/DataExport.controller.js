sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/BusyDialog"
], function (Controller, BusyDialog) {
  "use strict";
  return Controller.extend("sap.tutorials.admin.shell.controller.DataExport", {
    onInit: function () {
      this._busy = new BusyDialog({
        title: "Generating export",
        text: "This can take several minutes for large datasets."
      });
    },

    onDownload: function () {
      var sFormat = this.byId("formatSelect").getSelectedKey() || "csv";
      var oStrip = this.byId("errorStrip");
      oStrip.setVisible(false);

      this._busy.open();
      try {
        window.location.href = "/admin/exports/exportLegacyData?format=" + encodeURIComponent(sFormat);
      } catch (e) {
        oStrip.setText("Could not initiate download: " + (e && e.message));
        oStrip.setVisible(true);
      } finally {
        setTimeout(function () { this._busy.close(); }.bind(this), 1500);
      }
    }
  });
});
