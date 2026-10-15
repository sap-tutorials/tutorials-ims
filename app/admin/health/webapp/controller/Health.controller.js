sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel"
], function (Controller, JSONModel) {
  "use strict";

  return Controller.extend("sap.tutorials.admin.health.controller.Health", {

    onInit: function () {
      // Initialise health state model (scan result message).
      this.getView().setModel(new JSONModel({ scanMessage: "" }), "health");

      // Load membership issues from completionHealth() unbound function.
      var that = this;
      this.getView().setModel(new JSONModel({ issues: [] }), "membership");
      fetch("/admin/completionHealth()", { credentials: "include", headers: { Accept: "application/json" } })
        .then(function (r) {
          if (!r.ok) { throw new Error("HTTP " + r.status); }
          return r.json();
        })
        .then(function (d) {
          that.getView().getModel("membership").setData({ issues: d.value || d });
        })
        .catch(function (e) {
          sap.ui.require(["sap/m/MessageToast"], function (T) {
            T.show("Membership check failed: " + e.message);
          });
        });
    },

    // Calls the unbound OData action runUrlHealthScan() and shows the result.
    onRunScan: function () {
      var that = this;
      var oModel = this.getView().getModel();
      var oHealthModel = this.getView().getModel("health");

      this.byId("runScanBtn").setEnabled(false);
      oHealthModel.setProperty("/scanMessage", "Running scan…");

      var oOperation = oModel.bindContext("/runUrlHealthScan(...)");
      oOperation.execute().then(function () {
        var oResult = oOperation.getBoundContext().getObject();
        var sMsg = oResult.message ||
          ("Scan complete — ok: " + oResult.ok + ", broken: " + oResult.broken);
        oHealthModel.setProperty("/scanMessage", sMsg);
        // Refresh the URL status table binding.
        var oTable = that.byId("urlStatusTable");
        if (oTable) { oTable.getBinding("items").refresh(); }
      }).catch(function (e) {
        oHealthModel.setProperty("/scanMessage", "Scan failed: " + (e.message || e));
        sap.ui.require(["sap/m/MessageBox"], function (MB) {
          MB.error("Scan failed: " + (e.message || e));
        });
      }).finally(function () {
        that.byId("runScanBtn").setEnabled(true);
      });
    },

    // Formats the badSlots array into a readable comma-joined string of reasons.
    formatBadSlots: function (aBadSlots) {
      if (!Array.isArray(aBadSlots) || aBadSlots.length === 0) { return "—"; }
      return aBadSlots.map(function (s) {
        return s.reason || s.slot || JSON.stringify(s);
      }).join(", ");
    }
  });
});
