sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, Filter, FilterOperator, MessageToast, MessageBox) {
  "use strict";

  var OUTDATED_DAYS = 180;

  return Controller.extend("sap.tutorials.admin.shell.controller.TutorialDashboard", {
    onInit: function () {
      this.getView().setModel(new JSONModel({ enabled: false, recipients: "" }), "notifConfig");
      this._loadNotificationConfig();
      this._loadUserEmail();
    },

    _loadUserEmail: function () {
      fetch("/auth/user", { credentials: "include" })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (data && data.email) { this._sUserEmail = data.email; }
        }.bind(this))
        .catch(function () { /* filter will fall back to no-op */ });
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

    formatRowHighlight: function (sReviewedDate) {
      if (!sReviewedDate) { return "None"; }
      var iAge = Date.now() - new Date(sReviewedDate).getTime();
      return iAge > OUTDATED_DAYS * 86400000 ? "Error" : "None";
    },

    onTutorialLinkPress: function (oEvent) {
      var oSource = oEvent.getSource();
      var oContext = oSource.getBindingContext("admin");
      var sSlug = oContext.getProperty("tutorial/slug");
      if (sSlug) {
        window.open("/tutorials/" + encodeURIComponent(sSlug), "_blank");
      }
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

      if (this._bFilterMonitored && this._sUserEmail) {
        aFilters.push(new Filter("owner", FilterOperator.EQ, this._sUserEmail));
      }

      if (this._bFilterOutdated) {
        var dCutoff = new Date(Date.now() - OUTDATED_DAYS * 86400000).toISOString();
        aFilters.push(new Filter("reviewedDate", FilterOperator.LT, dCutoff));
      }

      var oTable = this.byId("tutorialMetaTable");
      var oBinding = oTable.getBinding("rows");
      oBinding.filter(aFilters.length ? new Filter({ filters: aFilters, and: true }) : []);
    },

    onColumnFilter: function (oEvent) {
      var oColumn = oEvent.getParameter("column");
      var sValue = oEvent.getParameter("value");
      var sFilterProperty = oColumn.getFilterProperty();
      var oTable = this.byId("tutorialMetaTable");
      var oBinding = oTable.getBinding("rows");

      if (!sFilterProperty) { return; }

      this._mColumnFilters = this._mColumnFilters || {};

      if (sValue) {
        this._mColumnFilters[sFilterProperty] = new Filter(sFilterProperty, FilterOperator.Contains, sValue);
      } else {
        delete this._mColumnFilters[sFilterProperty];
      }

      var aAllFilters = Object.values(this._mColumnFilters);
      oBinding.filter(aAllFilters.length ? new Filter({ filters: aAllFilters, and: true }) : []);
    }
  });
});
