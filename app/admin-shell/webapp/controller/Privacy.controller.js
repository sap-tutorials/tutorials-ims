sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Controller, JSONModel, MessageBox, MessageToast) {
  "use strict";
  return Controller.extend("sap.tutorials.admin.shell.controller.Privacy", {
    onInit: function () {
      this.getView().setModel(new JSONModel({ records: [] }), "history");
    },

    onSearchUser: function () {
      var sapId = this.byId("sapIdInput").getValue();
      if (!sapId) { MessageBox.warning("Enter a SAP ID"); return; }
      var oModel = this.getOwnerComponent().getModel("admin");
      var oFunc = oModel.bindContext("/findByAccountNumber(...)");
      oFunc.setParameter("sapId", sapId);
      oFunc.execute().then(function () {
        var oResult = oFunc.getBoundContext().getObject();
        this.getView().getModel("history").setProperty("/records", oResult.value || []);
      }.bind(this)).catch(function (err) {
        MessageBox.error("Search failed: " + err.message);
      });
    },

    onDownloadCsv: function () {
      var records = this.getView().getModel("history").getProperty("/records");
      if (!records.length) { MessageBox.information("No data to export"); return; }
      var header = "Date,Type,Title,Status\n";
      var rows = records.map(function (r) {
        return [r.completionDate, r.taskType, r.titleSnapshot, r.status].join(",");
      }).join("\n");
      var blob = new Blob([header + rows], { type: "text/csv" });
      var link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "user-history.csv";
      link.click();
    },

    onAnonymize: function () {
      var sapId = this.byId("sapIdInput").getValue();
      var dsrNumber = this.byId("dsrInput").getValue();
      if (!sapId) { MessageBox.warning("SAP ID required"); return; }
      MessageBox.confirm("This will permanently anonymize all data for " + sapId + ". Continue?", {
        title: "Confirm Anonymization",
        onClose: function (action) {
          if (action !== MessageBox.Action.OK) return;
          var oModel = this.getOwnerComponent().getModel("admin");
          var oAction;
          if (dsrNumber) {
            oAction = oModel.bindContext("/anonymizeByDsrRequest(...)");
            oAction.setParameter("sapId", sapId);
            oAction.setParameter("dsrRequestNumber", dsrNumber);
          } else {
            oAction = oModel.bindContext("/anonymizeUser(...)");
            oAction.setParameter("sapId", sapId);
          }
          oAction.execute().then(function () {
            MessageToast.show("User anonymized successfully");
            this.getView().getModel("history").setProperty("/records", []);
          }.bind(this)).catch(function (err) {
            MessageBox.error("Anonymization failed: " + err.message);
          });
        }.bind(this)
      });
    },

    onWizardComplete: function () {}
  });
});
