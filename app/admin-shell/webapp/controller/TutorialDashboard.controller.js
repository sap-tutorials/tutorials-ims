sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, Filter, FilterOperator, MessageToast, MessageBox) {
  "use strict";
  return Controller.extend("sap.tutorials.admin.shell.controller.TutorialDashboard", {
    onInit: function () {
      this.getView().setModel(new JSONModel({ enabled: false, recipients: "" }), "notifConfig");
      this._loadNotificationConfig();
    },

    _loadNotificationConfig: function () {
      var oModel = this.getOwnerComponent().getModel("admin");
      var oFunc = oModel.bindContext("/getNotificationConfig(...)");
      oFunc.execute().then(function () {
        var oResult = oFunc.getBoundContext().getObject();
        this.getView().getModel("notifConfig").setData({
          enabled: oResult.enabled,
          recipients: oResult.recipients
        });
      }.bind(this)).catch(function () { /* silently ignore on load failure */ });
    },

    onSyncMetadata: function () {
      var oModel = this.getOwnerComponent().getModel("admin");
      var oAction = oModel.bindContext("/syncTutorialMetadata(...)");
      oAction.execute().then(function () {
        var oResult = oAction.getBoundContext().getObject();
        MessageToast.show("Synced " + oResult.synced + " tutorials");
      }).catch(function (oError) {
        MessageBox.error("Sync failed: " + oError.message);
      });
    },

    onSendNotifications: function () {
      var oModel = this.getOwnerComponent().getModel("admin");
      var oAction = oModel.bindContext("/sendContributorNotifications(...)");
      oAction.execute().then(function () {
        var oResult = oAction.getBoundContext().getObject();
        MessageToast.show("Notified " + oResult.notified + " contributors");
      }).catch(function (oError) {
        MessageBox.error("Notification failed: " + oError.message);
      });
    },

    onToggleMonitored: function (oEvent) {
      var oContext = oEvent.getSource().getBindingContext("admin");
      oContext.setProperty("monitored", oEvent.getParameter("selected"));
    },

    onToggleReviewed: function (oEvent) {
      var oContext = oEvent.getSource().getBindingContext("admin");
      oContext.setProperty("reviewed", oEvent.getParameter("selected"));
    },

    onToggleNotifications: function (oEvent) {
      var bEnabled = oEvent.getParameter("state");
      var oModel = this.getOwnerComponent().getModel("admin");
      var oAction = oModel.bindContext("/toggleNotifications(...)");
      oAction.setParameter("enabled", bEnabled);
      oAction.execute().then(function () {
        MessageToast.show("Notifications " + (bEnabled ? "enabled" : "disabled"));
      }).catch(function (oError) {
        MessageBox.error("Toggle failed: " + oError.message);
      });
    },

    onSaveRecipients: function () {
      var sRecipients = this.byId("notifRecipients").getValue();
      var oModel = this.getOwnerComponent().getModel("admin");
      var oAction = oModel.bindContext("/updateNotificationRecipients(...)");
      oAction.setParameter("recipients", sRecipients);
      oAction.execute().then(function () {
        MessageToast.show("Recipients updated");
      }).catch(function (oError) {
        MessageBox.error("Update failed: " + oError.message);
      });
    },

    onSearch: function (oEvent) {
      var sQuery = oEvent.getParameter("newValue");
      this._sSearchQuery = sQuery || "";
      this._applyFilters();
    },

    onFilterMonitored: function (oEvent) {
      this._bFilterMonitored = oEvent.getParameter("selected");
      this._applyFilters();
    },

    onFilterOutdated: function (oEvent) {
      this._bFilterOutdated = oEvent.getParameter("selected");
      this._applyFilters();
    },

    _applyFilters: function () {
      var aFilters = [];
      if (this._sSearchQuery) {
        aFilters.push(new Filter("tutorial/title", FilterOperator.Contains, this._sSearchQuery));
      }
      if (this._bFilterMonitored) {
        aFilters.push(new Filter("monitored", FilterOperator.EQ, true));
      }
      if (this._bFilterOutdated) {
        aFilters.push(new Filter("outdated", FilterOperator.EQ, true));
      }
      var oTable = this.byId("tutorialMetaTable");
      var oBinding = oTable.getBinding("rows");
      oBinding.filter(aFilters.length ? new Filter({ filters: aFilters, and: true }) : []);
    }
  });
});
