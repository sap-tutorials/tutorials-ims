sap.ui.define(["sap/ui/core/mvc/ControllerExtension"], function (ControllerExtension) {
  "use strict";
  return ControllerExtension.extend("sap.tutorials.admin.health.ext.MembershipIssues", {
    onInit: function () {
      // GET /admin/completionHealth() → bind result to a JSONModel on the view.
      fetch("/admin/completionHealth()", { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var m = new sap.ui.model.json.JSONModel({ issues: d.value || d });
          this.getView().setModel(m, "membership");
        }.bind(this))
        .catch(function (e) { sap.ui.require(["sap/m/MessageToast"], function (T) { T.show("Membership check failed: " + e.message); }); });
    },

    onRunUrlHealthScan: function () {
      var that = this;
      var oModel = this.getView().getModel();
      var oOperation = oModel.bindContext("/runUrlHealthScan(...)");
      oOperation.execute().then(function () {
        var oResult = oOperation.getBoundContext().getObject();
        sap.ui.require(["sap/m/MessageToast"], function (T) {
          T.show(oResult.message || ("Scan complete — ok: " + oResult.ok + ", broken: " + oResult.broken));
        });
        that.getExtensionAPI().refresh();
      }).catch(function (e) {
        sap.ui.require(["sap/m/MessageBox"], function (MB) {
          MB.error("Scan failed: " + (e.message || e));
        });
      });
    }
  });
});
