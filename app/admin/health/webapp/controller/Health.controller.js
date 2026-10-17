sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/p13n/Engine",
  "sap/m/p13n/SelectionController",
  "sap/m/p13n/SortController",
  "sap/m/p13n/FilterController",
  "sap/m/p13n/MetadataHelper",
  "sap/ui/model/Sorter"
], function (Controller, JSONModel, Filter, FilterOperator, Engine, SelectionController, SortController, FilterController, MetadataHelper, Sorter) {
  "use strict";

  // Column metadata shared by the p13n Engine (keys map to OData properties).
  var URL_STATUS_COLUMNS = [
    { key: "colSlug", label: "Slug", path: "slug" },
    { key: "colLinkStatus", label: "Link Status", path: "linkStatus" },
    { key: "colLastChecked", label: "Last Checked", path: "lastChecked" },
    { key: "colOverride", label: "Override", path: "linkStatusOverride" }
  ];

  return Controller.extend("sap.tutorials.admin.health.controller.Health", {

    onInit: function () {
      // Initialise health state model (scan result message).
      this.getView().setModel(new JSONModel({ scanMessage: "" }), "health");

      // State backing the URL-status toolbar quick-filters and row count.
      this._sSlugQuery = "";
      this._sStatusQuery = "all";
      this.getView().setModel(new JSONModel({ count: 0 }), "urlStatus");

      this._registerUrlStatusP13n();

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

    // Register the URL-status table with the p13n Engine for Columns/Sort/Filter.
    _registerUrlStatusP13n: function () {
      var oTable = this.byId("urlStatusTable");
      var aMetadata = URL_STATUS_COLUMNS.map(function (c) {
        return { key: c.key, label: c.label, path: c.path };
      });
      this._oUrlStatusMetadataHelper = new MetadataHelper(aMetadata);

      Engine.getInstance().register(oTable, {
        helper: this._oUrlStatusMetadataHelper,
        controller: {
          Columns: new SelectionController({
            targetAggregation: "columns",
            control: oTable
          }),
          Sorter: new SortController({ control: oTable }),
          Filter: new FilterController({ control: oTable })
        }
      });

      Engine.getInstance().attachStateChange(this._onUrlStatusStateChange.bind(this));
      // Keep the header count in sync as rows load / filter.
      oTable.attachUpdateFinished(this._onUrlStatusUpdateFinished, this);
    },

    // Apply Engine-driven column visibility, sort and filter state to the table.
    _onUrlStatusStateChange: function (oEvt) {
      var oTable = this.byId("urlStatusTable");
      if (oEvt.getParameter("control") !== oTable) { return; }
      var oState = oEvt.getParameter("state");
      if (!oState) { return; }

      // Columns: show/hide by the Engine's reported selection. (Column
      // reordering is intentionally not wired — the cells aggregation would
      // have to be reordered in lockstep; visibility covers the admin need.)
      var aCols = oTable.getColumns();
      var mColByKey = {};
      aCols.forEach(function (oCol) { mColByKey[oCol.getId().split("--").pop()] = oCol; });
      Object.keys(mColByKey).forEach(function (sKey) {
        var bVisible = (oState.Columns || []).some(function (c) { return c.key === sKey; });
        mColByKey[sKey].setVisible(bVisible);
      });

      // Sort.
      var aSorters = (oState.Sorter || []).map(function (s) {
        var oMeta = URL_STATUS_COLUMNS.filter(function (c) { return c.key === s.key; })[0];
        return new Sorter(oMeta ? oMeta.path : s.key, s.descending);
      });
      oTable.getBinding("items").sort(aSorters);

      // Filter (merge Engine filters with the toolbar quick-filters).
      this._aP13nFilters = (oState.Filter ? this._buildFiltersFromState(oState.Filter) : []);
      this._applyUrlStatusFilters();
    },

    // Convert the Engine filter state map into sap.ui.model.Filter instances.
    _buildFiltersFromState: function (oFilterState) {
      var aFilters = [];
      Object.keys(oFilterState).forEach(function (sKey) {
        var oMeta = URL_STATUS_COLUMNS.filter(function (c) { return c.key === sKey; })[0];
        var sPath = oMeta ? oMeta.path : sKey;
        (oFilterState[sKey] || []).forEach(function (oCond) {
          var aVals = oCond.values || [];
          aFilters.push(new Filter(sPath, FilterOperator[oCond.operator] || FilterOperator.EQ, aVals[0], aVals[1]));
        });
      });
      return aFilters;
    },

    // Keep the "(n)" count in the table title current after each load.
    _onUrlStatusUpdateFinished: function (oEvt) {
      var iTotal = oEvt.getParameter("total");
      this.getView().getModel("urlStatus").setProperty("/count", iTotal);
    },

    // Open the p13n settings dialog (Columns, Sort, Filter).
    onUrlStatusPersonalize: function (oEvt) {
      Engine.getInstance().show(this.byId("urlStatusTable"), ["Columns", "Sorter", "Filter"], {
        contentWidth: "32rem",
        contentHeight: "40rem",
        source: oEvt.getSource()
      });
    },

    // Toolbar slug search.
    onUrlStatusSearch: function (oEvt) {
      this._sSlugQuery = (oEvt.getParameter("newValue") !== undefined
        ? oEvt.getParameter("newValue")
        : oEvt.getParameter("query")) || "";
      this._applyUrlStatusFilters();
    },

    // Toolbar status quick-filter.
    onUrlStatusFilterChange: function (oEvt) {
      this._sStatusQuery = oEvt.getParameter("selectedItem").getKey();
      this._applyUrlStatusFilters();
    },

    // Combine quick-filters + p13n filters and apply them to the binding.
    _applyUrlStatusFilters: function () {
      var oBinding = this.byId("urlStatusTable").getBinding("items");
      if (!oBinding) { return; }
      var aFilters = (this._aP13nFilters || []).slice();

      if (this._sSlugQuery) {
        aFilters.push(new Filter("slug", FilterOperator.Contains, this._sSlugQuery.toLowerCase()));
      }

      if (this._sStatusQuery === "notok") {
        aFilters.push(new Filter("linkStatus", FilterOperator.NE, "OK"));
      } else if (this._sStatusQuery && this._sStatusQuery !== "all") {
        aFilters.push(new Filter("linkStatus", FilterOperator.EQ, this._sStatusQuery));
      }

      oBinding.filter(aFilters.length ? new Filter({ filters: aFilters, and: true }) : []);
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
    },

    // Formats an ISO timestamp into a locale date-time string.
    // A formatter (not an expression binding) because UI5 expression-binding
    // grammar forbids `new` — `{= new Date(...) }` is a parse error.
    formatTimestamp: function (sTimestamp) {
      if (!sTimestamp) { return "—"; }
      var oDate = new Date(sTimestamp);
      return isNaN(oDate.getTime()) ? "—" : oDate.toLocaleString();
    }
  });
});
