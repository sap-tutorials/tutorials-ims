sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/core/format/DateFormat",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, Filter, FilterOperator, DateFormat, MessageToast, MessageBox) {
  "use strict";

  var OUTDATED_DAYS = 180;
  // Single shared formatter (Issue #373). Idiomatic UI5 read-side date
  // rendering — bypasses the OData v4 DateTimeOffset type's auto-conversion
  // to String targetType which throws FormatException when the wire value
  // is the ISO 8601 form.
  var DATE_FORMATTER = DateFormat.getDateInstance({ style: "medium" });

  return Controller.extend("sap.tutorials.admin.shell.controller.TutorialDashboard", {
    onInit: function () {
      this.getView().setModel(new JSONModel({ enabled: false, recipients: "" }), "notifConfig");
      // #2199 — watch-list state. `_oWatchedSet` holds the tutorial IDs the
      // caller currently watches (drives the eye-icon column); the "watch"
      // JSONModel's /version integer is bumped on every change so the icon
      // formatters re-evaluate for all rows. `_sScope` is the Show: selector
      // ("all" | "owned" | "watching" | "both").
      this.getView().setModel(new JSONModel({ version: 0 }), "watch");
      this._oWatchedSet = new Set();
      this._sScope = "all";
      this._loadNotificationConfig();
      this._loadUserEmail();
      this._loadWatchedIds();
      // Issue #377: hide DELETED / INACTIVE tutorials from Tutorial Health.
      // The actual filter application happens in onAfterRendering — the
      // table's rows-binding doesn't exist during onInit (oTable.getBinding
      // returns undefined and the silent early-return in _applyBaselineFilter
      // means the filter never lands). Track that we've already applied so
      // re-renders don't re-fire it.
      this._baselineFilterApplied = false;
    },

    onAfterRendering: function () {
      if (this._baselineFilterApplied) { return; }
      var oTable = this.byId("tutorialMetaTable");
      var oBinding = oTable && oTable.getBinding("rows");
      if (!oBinding) { return; }  // wait for next render
      this._baselineFilterApplied = true;
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
    // filters from _sSearchQuery / _sScope / _bFilterOutdated.
    _buildFilters: function () {
      var aUser = [];
      if (this._sSearchQuery) {
        aUser.push(new Filter("tutorial/title", FilterOperator.Contains, this._sSearchQuery));
      }
      if (this._sScope && this._sScope !== "all") {
        // #2199 — the Show: selector narrows the table to the caller's owned
        // set (/author/MyTutorials — 4-source UNION, #777), watched set
        // (/author/MyMonitoredTutorials, #923), or their union ("both"). The
        // resolved id list is cached in _aScopeIds by _refreshScopeIdsThenFilter.
        var aIds = Array.isArray(this._aScopeIds) ? this._aScopeIds : [];
        if (aIds.length > 0) {
          var aIdFilters = aIds.map(function (id) {
            return new Filter("tutorial_ID", FilterOperator.EQ, id);
          });
          aUser.push(new Filter({ filters: aIdFilters, and: false }));
        } else {
          // Scope is active but the caller has no matching tutorials — apply a
          // never-match filter so the table renders empty (not unfiltered).
          aUser.push(new Filter("tutorial_ID", FilterOperator.EQ, "__NO_MATCH__"));
        }
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
          if (data && data.userId) { this._sUserId = data.userId; }
        }.bind(this))
        .catch(function () { /* filter will fall back to no-op */ });
    },

    // Issue #777: fetch the user's "mine" tutorial IDs via the canonical
    // MyTutorialsView (4-source UNION). Returns a Promise resolving to
    // an array of tutorial_ID strings. Falls back to [] on any error
    // so the admin tile degrades gracefully (no toggle works, no crash).
    //
    // $top=1000 cap: practical ceiling well above the expected per-user
    // count. Tom on DEV has ~77; the most prolific real-world author is
    // unlikely to exceed a few hundred. If anyone ever does, the filter
    // truncates silently — the toggle still works, just shows the top 1000.
    // For thousands-of-tutorials users this approach hits OData URL length
    // limits before $top does; the right fix at that scale is a server-side
    // bound endpoint (e.g. /admin/MyTutorialIds), out of scope here.
    _fetchMyTutorialIds: function () {
      if (!this._sUserId) return Promise.resolve([]);
      // AuthorService exposes MyTutorials; use it directly. Other paths
      // (admin OData expand) would require AdminService to project
      // MyTutorialsView, which is heavier than needed here.
      return fetch("/author/MyTutorials?$select=tutorial_ID&$top=1000", { credentials: "include" })
        .then(function (res) { return res.ok ? res.json() : { value: [] }; })
        .then(function (data) {
          return (data.value || []).map(function (r) { return r.tutorial_ID; });
        })
        .catch(function () { return []; });
    },

    // #2199 — fetch the caller's watch-list tutorial IDs via the row-scoped
    // /author/MyMonitoredTutorials (TutorialMonitors → MyMonitoredTutorialsView).
    // Same $top=1000 caveat as _fetchMyTutorialIds. Degrades to [] on error.
    _fetchWatchedIds: function () {
      return fetch("/author/MyMonitoredTutorials?$select=tutorial_ID&$top=1000", { credentials: "include" })
        .then(function (res) { return res.ok ? res.json() : { value: [] }; })
        .then(function (data) {
          return (data.value || []).map(function (r) { return r.tutorial_ID; });
        })
        .catch(function () { return []; });
    },

    // Load the watch set and refresh the eye-icon column. Called on init and
    // after any toggle so the icons reflect the current server state.
    _loadWatchedIds: function () {
      return this._fetchWatchedIds().then(function (aIds) {
        this._oWatchedSet = new Set(aIds);
        this._bumpWatchVersion();
        return aIds;
      }.bind(this));
    },

    // Bump the "watch" model's /version so the icon/tooltip formatters
    // re-evaluate for every row (their binding includes /version as a part).
    _bumpWatchVersion: function () {
      var oModel = this.getView().getModel("watch");
      if (oModel) { oModel.setProperty("/version", (oModel.getProperty("/version") || 0) + 1); }
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

    // Enable/disable the review action buttons based on whether any rows
    // are selected. Wired to the table's rowSelectionChange event.
    onRowSelectionChange: function () {
      var bHasSelection = this._getSelectedTutorialIds().length > 0;
      this.byId("markReviewedBtn").setEnabled(bHasSelection);
      this.byId("snoozeBtn").setEnabled(bHasSelection);
    },

    // Collect the tutorial id of every currently-selected row. Skips any
    // rows without a resolvable context (e.g. selection index beyond the
    // loaded page) or missing id.
    //
    // Selection is owned by the MultiSelectionPlugin (see the view) because
    // the table binds an OData V4 model — the table-level getSelectedIndices()
    // returns [] in that setup. We read indices off the plugin and resolve
    // each to a binding context via the table's getContextByIndex().
    //
    // Read the id via the expanded 'tutorial/ID' association path, NOT the
    // flat 'tutorial_ID' FK: the rows binding uses $expand=tutorial(...) and
    // OData v4 does NOT project the flat FK column into the response when the
    // association is expanded (verified at runtime — the selected row object
    // exposes 'tutorial' but no 'tutorial_ID'). tutorial_ID === tutorial.ID
    // in this model (meta.tutorial.ID = ID), so the value is identical and is
    // exactly what /reviewTutorial + /snoozeTutorial expect as tutorialId.
    _getSelectedTutorialIds: function () {
      var oTable = this.byId("tutorialMetaTable");
      var oPlugin = this._getSelectionPlugin();
      var aIndices = oPlugin ? oPlugin.getSelectedIndices() : oTable.getSelectedIndices();
      var aIds = [];
      aIndices.forEach(function (iIndex) {
        var oContext = oTable.getContextByIndex(iIndex);
        var sId = oContext && oContext.getProperty("tutorial/ID");
        if (sId) { aIds.push(sId); }
      });
      return aIds;
    },

    // Locate the table's MultiSelectionPlugin instance. Cached after first
    // lookup. Returns undefined if the plugin is absent (defensive — the
    // caller falls back to the table-level selection API).
    _getSelectionPlugin: function () {
      if (this._oSelectionPlugin) { return this._oSelectionPlugin; }
      var oTable = this.byId("tutorialMetaTable");
      if (!oTable || typeof oTable.getDependents !== "function") { return undefined; }
      this._oSelectionPlugin = oTable.getDependents().find(function (oDep) {
        return oDep && oDep.isA && oDep.isA("sap.ui.table.plugins.MultiSelectionPlugin");
      });
      return this._oSelectionPlugin;
    },

    // Invoke an unbound AdminService action once per tutorial id. Returns a
    // Promise resolving to { ok, failed } counts. Actions run sequentially to
    // keep the OData v4 change-set simple and the error handling per-row.
    _runReviewAction: function (aTutorialIds, fnBindAction) {
      var oModel = this.getOwnerComponent().getModel("admin");
      var iOk = 0;
      var iFailed = 0;
      var chain = Promise.resolve();
      aTutorialIds.forEach(function (sTutorialId) {
        chain = chain.then(function () {
          var oAction = fnBindAction(oModel, sTutorialId);
          return oAction.execute().then(function () {
            iOk++;
          }).catch(function () {
            iFailed++;
          });
        });
      });
      return chain.then(function () { return { ok: iOk, failed: iFailed }; });
    },

    onMarkReviewed: function () {
      var aIds = this._getSelectedTutorialIds();
      if (aIds.length === 0) { return; }
      var oButton = this.byId("markReviewedBtn");
      oButton.setEnabled(false);
      oButton.setBusy(true);
      this._runReviewAction(aIds, function (oModel, sTutorialId) {
        var oAction = oModel.bindContext("/reviewTutorial(...)");
        oAction.setParameter("tutorialId", sTutorialId);
        return oAction;
      }).then(function (oResult) {
        this._reportReviewResult("reviewed", oResult);
      }.bind(this)).finally(function () {
        oButton.setBusy(false);
        this._refreshAfterReview();
      }.bind(this));
    },

    onSnooze: function () {
      var aIds = this._getSelectedTutorialIds();
      if (aIds.length === 0) { return; }
      var that = this;
      MessageBox.confirm(
        "Snooze notifications for " + aIds.length + " tutorial" + (aIds.length === 1 ? "" : "s") + " by 30 days?",
        {
          title: "Snooze",
          onClose: function (sAction) {
            if (sAction !== MessageBox.Action.OK) { return; }
            var oButton = that.byId("snoozeBtn");
            oButton.setEnabled(false);
            oButton.setBusy(true);
            that._runReviewAction(aIds, function (oModel, sTutorialId) {
              var oAction = oModel.bindContext("/snoozeTutorial(...)");
              oAction.setParameter("tutorialId", sTutorialId);
              oAction.setParameter("days", 30);
              return oAction;
            }).then(function (oResult) {
              that._reportReviewResult("snoozed", oResult);
            }).finally(function () {
              oButton.setBusy(false);
              that._refreshAfterReview();
            });
          }
        }
      );
    },

    // Summarise the outcome of a bulk review/snooze run.
    _reportReviewResult: function (sVerb, oResult) {
      if (oResult.failed === 0) {
        MessageToast.show(oResult.ok + " tutorial" + (oResult.ok === 1 ? "" : "s") + " " + sVerb + ".");
      } else {
        MessageBox.warning(
          oResult.ok + " " + sVerb + ", " + oResult.failed + " failed.",
          { title: "Partial success" }
        );
      }
    },

    // Refresh the table and clear the selection after a review/snooze run so
    // the new reviewedDate / highlight state is reflected and buttons reset.
    _refreshAfterReview: function () {
      var oTable = this.byId("tutorialMetaTable");
      var oPlugin = this._getSelectionPlugin();
      // Selection is plugin-owned under the V4 binding — clear it there.
      if (oPlugin) { oPlugin.clearSelection(); } else { oTable.clearSelection(); }
      var oBinding = oTable.getBinding("rows");
      if (oBinding) { oBinding.refresh(); }
      this.byId("markReviewedBtn").setEnabled(false);
      this.byId("snoozeBtn").setEnabled(false);
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

    // Issue #373: format an OData v4 Edm.DateTimeOffset (ISO 8601 string) for
    // display. Used in place of `type: sap.ui.model.odata.type.DateTimeOffset`
    // bindings which throw FormatException when UI5 auto-converts the value
    // to the bound control's String targetType. Plain formatter callbacks
    // run only in the read direction so there's no parse round-trip to
    // confuse.
    formatDateMedium: function (vValue) {
      if (!vValue) { return ""; }
      var d = vValue instanceof Date ? vValue : new Date(vValue);
      if (Number.isNaN(d.getTime())) { return ""; }
      return DATE_FORMATTER.format(d);
    },

    // #2199 — eye-icon column formatters. `this._oWatchedSet` is the source
    // of truth; the unused iVersion part only exists to re-trigger the
    // formatter when _bumpWatchVersion() runs after a toggle/refresh.
    formatWatchIcon: function (sTutorialId) {
      return this._oWatchedSet && this._oWatchedSet.has(sTutorialId)
        ? "sap-icon://show"
        : "sap-icon://hide";
    },

    formatWatchTooltip: function (sTutorialId) {
      return this._oWatchedSet && this._oWatchedSet.has(sTutorialId)
        ? "Stop watching this tutorial"
        : "Watch this tutorial";
    },

    // #2199 — add/remove the row's tutorial from the caller's watch list via
    // AuthorService.toggleMonitor. Optimistically flips the local set on
    // success, then keeps the current scope filter consistent (a row watched
    // while viewing "Watching"/"Owned + watching" stays/leaves accordingly).
    onToggleWatch: function (oEvent) {
      var oButton = oEvent.getSource();
      var oContext = oButton.getBindingContext("admin");
      var sTutorialId = oContext && oContext.getProperty("tutorial/ID");
      if (!sTutorialId) { return; }
      var bNewStatus = !this._oWatchedSet.has(sTutorialId);
      oButton.setEnabled(false);
      var oModel = this.getOwnerComponent().getModel("author");
      var oAction = oModel.bindContext("/toggleMonitor(...)");
      oAction.setParameter("tutorialId", sTutorialId);
      oAction.setParameter("status", bNewStatus);
      oAction.execute().then(function () {
        var bResult = oAction.getBoundContext().getObject().value;
        if (bResult) {
          this._oWatchedSet.add(sTutorialId);
          MessageToast.show("Added to your watch list");
        } else {
          this._oWatchedSet.delete(sTutorialId);
          MessageToast.show("Removed from your watch list");
        }
        this._bumpWatchVersion();
        // If the watch set feeds the current scope, re-resolve and re-filter
        // so an unwatched row drops out (or a watched row appears).
        if (this._sScope === "watching" || this._sScope === "both") {
          this._refreshScopeIdsThenFilter();
        }
      }.bind(this)).catch(function (oError) {
        MessageBox.error("Watch toggle failed: " + (oError && oError.message ? oError.message : "Unknown error"));
      }).finally(function () {
        oButton.setEnabled(true);
      });
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

    // #2199 — the Show: selector. Resolves the owned and/or watched id sets
    // for the chosen scope, caches their union in _aScopeIds, then re-filters.
    onScopeChange: function (oEvent) {
      var oItem = oEvent.getParameter("selectedItem");
      this._sScope = oItem ? oItem.getKey() : "all";
      this._refreshScopeIdsThenFilter();
    },

    _refreshScopeIdsThenFilter: function () {
      var sScope = this._sScope;
      if (sScope === "all") {
        this._aScopeIds = null;
        this._applyFilters();
        return;
      }
      var bOwned = (sScope === "owned" || sScope === "both");
      var bWatching = (sScope === "watching" || sScope === "both");
      var pOwned = bOwned ? this._fetchMyTutorialIds() : Promise.resolve([]);
      var pWatched = bWatching ? this._fetchWatchedIds() : Promise.resolve([]);
      Promise.all([pOwned, pWatched]).then(function (aResults) {
        var aWatched = aResults[1];
        // Keep the eye-icon column in sync whenever we've just fetched the
        // watch set (watching/both scopes).
        if (bWatching) {
          this._oWatchedSet = new Set(aWatched);
          this._bumpWatchVersion();
        }
        this._aScopeIds = Array.from(new Set(aResults[0].concat(aWatched)));
        this._applyFilters();
      }.bind(this));
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
