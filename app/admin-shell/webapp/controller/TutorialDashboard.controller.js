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
      // Issue #377: hide DELETED / INACTIVE tutorials from Tutorial Health
      // (1,359 of 2,892 tutorials on prod are DELETED, dragging in noise +
      // missing review dates). The baseline filter is applied once after
      // the binding initializes; both user-filter entry points
      // (_applyFilters, onColumnFilter) layer their filters AND-combined
      // with the baseline so it's never lost.
      this._applyBaselineFilter();
    },

    // Apply the always-on filter (excludes DELETED + INACTIVE tutorials).
    // Idempotent — safe to call repeatedly.
    _applyBaselineFilter: function () {
      var oTable = this.byId("tutorialMetaTable");
      if (!oTable) { return; }
      var oBinding = oTable.getBinding("rows");
      if (!oBinding) { return; }
      oBinding.filter(this._buildFilters());
    },

    // Build the active filter expression. Always includes the
    // baseline (live tutorials only), AND-combined with any user
    // filters from _sSearchQuery / _bFilterMonitored / _bFilterOutdated.
    _buildFilters: function () {
      var aUser = [];
      if (this._sSearchQuery) {
        aUser.push(new Filter("tutorial/title", FilterOperator.Contains, this._sSearchQuery));
      }
      if (this._bFilterMonitored && this._sUserEmail) {
        aUser.push(new Filter("owner", FilterOperator.EQ, this._sUserEmail));
      }
      if (this._bFilterOutdated) {
        var dCutoff = new Date(Date.now() - OUTDATED_DAYS * 86400000).toISOString();
        aUser.push(new Filter("reviewedDate", FilterOperator.LT, dCutoff));
      }
      var aColumn = Object.values(this._mColumnFilters || {});

      // Baseline: tutorial.status is null (legacy ACTIVE default) OR ACTIVE.
      // DELETED / INACTIVE rows are excluded — they're not part of the
      // health-tracking surface and they typically have no reviewedDate.
      var oBaseline = new Filter({
        filters: [
          new Filter("tutorial/status", FilterOperator.EQ, null),
          new Filter("tutorial/status", FilterOperator.EQ, "ACTIVE")
        ],
        and: false
      });

      var aAll = [oBaseline].concat(aUser).concat(aColumn);
      return aAll.length === 1
        ? aAll[0]
        : new Filter({ filters: aAll, and: true });
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
      var oButton = this.byId("syncMetadataBtn");
      var sOriginalText = oButton.getText();
      oButton.setEnabled(false);
      oButton.setBusy(true);
      oButton.setText("Syncing...");
      var oModel = this.getOwnerComponent().getModel("admin");
      var oAction = oModel.bindContext("/syncTutorialMetadata(...)");
      oAction.execute().then(function () {
        var oResult = oAction.getBoundContext().getObject();
        var sMessage = oResult.synced > 0
          ? "Sync complete. Backfilled " + oResult.synced + " missing tutorial metadata row" + (oResult.synced === 1 ? "" : "s") + "."
          : "Sync complete. All tutorials already have metadata.";
        MessageBox.success(sMessage, { title: "Sync Metadata" });
        var oTable = this.byId("tutorialMetaTable");
        var oBinding = oTable && oTable.getBinding("rows");
        if (oBinding) { oBinding.refresh(); }
      }.bind(this)).catch(function (oError) {
        MessageBox.error("Sync failed: " + (oError && oError.message ? oError.message : "Unknown error"), { title: "Sync Metadata" });
      }).finally(function () {
        oButton.setEnabled(true);
        oButton.setBusy(false);
        oButton.setText(sOriginalText);
      });
    },

    onSendNotifications: function () {
      var oButton = this.byId("sendNotificationsBtn");
      var sOriginalText = oButton.getText();
      oButton.setEnabled(false);
      oButton.setBusy(true);
      oButton.setText("Sending...");
      var oModel = this.getOwnerComponent().getModel("admin");
      var oAction = oModel.bindContext("/sendContributorNotifications(...)");
      oAction.execute().then(function () {
        var oResult = oAction.getBoundContext().getObject();
        MessageBox.success("Notified " + oResult.notified + " contributor" + (oResult.notified === 1 ? "" : "s") + ".", { title: "Send Notifications" });
      }).catch(function (oError) {
        MessageBox.error("Notification failed: " + (oError && oError.message ? oError.message : "Unknown error"), { title: "Send Notifications" });
      }).finally(function () {
        oButton.setEnabled(true);
        oButton.setBusy(false);
        oButton.setText(sOriginalText);
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

    formatRowHighlight: function (vReviewedDate) {
      // The binding part comes through as either a JS Date (when the binding's
      // type is sap.ui.model.odata.type.DateTimeOffset) or a string (basic
      // binding). Handle both; bail safely on null/undefined/invalid.
      if (!vReviewedDate) { return "None"; }
      var iTime = vReviewedDate instanceof Date
        ? vReviewedDate.getTime()
        : new Date(vReviewedDate).getTime();
      if (Number.isNaN(iTime)) { return "None"; }
      var iAge = Date.now() - iTime;
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
      var oTable = this.byId("tutorialMetaTable");
      var oBinding = oTable.getBinding("rows");
      oBinding.filter(this._buildFilters());
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

      oBinding.filter(this._buildFilters());
    }
  });
});
