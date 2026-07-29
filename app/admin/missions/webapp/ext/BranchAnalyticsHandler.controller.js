sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension",
  "sap/ui/model/json/JSONModel",
  "sap/m/TableSelectDialog",
  "sap/m/ColumnListItem",
  "sap/m/Column",
  "sap/m/Label",
  "sap/m/Text",
  // AMD shim from Task 7 — isomorphic ESM merge helper exposed as a UI5 module.
  "sap/tutorials/admin/missions/ext/merge-branch-perf-amd"
], function (ControllerExtension, JSONModel, TableSelectDialog, ColumnListItem, Column, Label, Text, mergeBranchPerfMod) {
  "use strict";

  var mergeBranchPerf = mergeBranchPerfMod.mergeBranchPerf;

  // Path Items "Task" column value help (issue #426).
  //
  // WHY these live on the controllerExtension (not a core:require handler in the
  // fragment): FE instantiates controllerExtensions during ObjectPage component
  // init — BEFORE it clones the completionPaths LineItem column templates. The
  // TaskColumn.fragment.xml references these methods by bare name
  // (valueHelpRequest="onTaskValueHelp", change="onTaskCheckpointChange",
  // showValueHelp="{path:'taskType', formatter:'.formatTaskShowValueHelp'}"),
  // which FE resolves against the OP controller + its extensions. That resolution
  // is deterministic and race-free, unlike a core:require module that loads lazily
  // and lost the clone race on the deployed shell (child components ship without a
  // Component-preload.js). See docs/developers/reference and the fragment comment.
  //
  // showValueHelp uses a FORMATTER (raw String -> Boolean return), NOT an
  // expression binding over a Boolean property — so the String taskType is never
  // coerced to Boolean (which threw "TUTORIAL is not a valid boolean value").
  // Per-entity picker column config. Each `field` is both a $select column and a
  // TableSelectDialog table column. Free-text search uses OData $search (→ HANA
  // CONTAINS via @cds.search on AdminService.Tutorials: title/slug/primaryTag/
  // description) so a valid row like cp-aibus-dox-ui-sub is findable by slug/tag,
  // not just a title-prefix match. Groups has slug but no primaryTag and no
  // @cds.search, so it searches title/slug only via a per-field OR filter.
  var PICKER_CONFIG = {
    Tutorials: {
      titleField: "title",
      columns: [
        { field: "title", label: "Title" },
        { field: "slug", label: "Slug" },
        { field: "primaryTag", label: "Tag" },
        { field: "legacyIdStr", label: "Legacy ID" }
      ],
      useSearch: true // AdminService.Tutorials has @cds.search
    },
    Groups: {
      titleField: "title",
      columns: [
        { field: "title", label: "Title" },
        { field: "slug", label: "Slug" },
        { field: "legacyIdStr", label: "Legacy ID" }
      ],
      useSearch: true // Groups projection also serves title/slug $search
    }
  };

  function _openPicker(oInput, sEntitySet) {
    var oContext = oInput.getBindingContext();
    if (!oContext) return;
    var oODataModel = oContext.getModel();
    var oCfg = PICKER_CONFIG[sEntitySet];
    var sIdField = "ID";

    var oDialog = new TableSelectDialog({
      title: "Select " + (sEntitySet === "Tutorials" ? "Tutorial" : "Group"),
      noDataText: "No matches",
      growing: true,
      growingThreshold: 50,
      // Server-side search: re-bind the list with $search so ALL rows are
      // searched at the DB (not just the client-loaded page). This is why the
      // old 200-row title-only client filter hid valid rows.
      search: function (oEvent) {
        var sQuery = oEvent.getParameter("value") || "";
        var oBinding = oEvent.getSource().getBinding("items");
        if (!oBinding) return;
        oBinding.changeParameters({ $search: sQuery ? JSON.stringify(sQuery) : undefined });
      },
      confirm: function (oEvent) {
        var oItem = oEvent.getParameter("selectedItem");
        if (!oItem) return;
        var oData = oItem.getBindingContext().getObject();
        // Set FK only — V4 model refreshes the row and re-resolves the navigation
        // property (tutorial/title or group/title) automatically via $expand.
        oContext.setProperty(sEntitySet === "Tutorials" ? "tutorial_ID" : "group_ID", oData[sIdField]);
        oDialog.destroy();
      },
      cancel: function () { oDialog.destroy(); }
    });

    // Table columns from config.
    oCfg.columns.forEach(function (col) {
      oDialog.addColumn(new Column({ header: new Label({ text: col.label }) }));
    });

    var sSelect = [sIdField].concat(oCfg.columns.map(function (c) { return c.field; })).join(",");
    var oTemplate = new ColumnListItem({
      cells: oCfg.columns.map(function (col) { return new Text({ text: "{" + col.field + "}" }); })
    });

    oDialog.setModel(oODataModel);
    oDialog.bindAggregation("items", {
      path: "/" + sEntitySet,
      parameters: { $select: sSelect, $count: true },
      template: oTemplate
    });

    oDialog.open();
  }

  return ControllerExtension.extend("sap.tutorials.admin.missions.ext.BranchAnalyticsHandler", {
    override: {
      onInit: function () {
        // Empty model up front so the visible-binding doesn't crash on first paint.
        this.base.getView().setModel(new JSONModel([]), "branchPerf");
      },
      // Fiori Elements v4 canonical lifecycle hook — fires every time the OP
      // re-binds to a new context (initial nav, cross-mission nav, refresh).
      routing: {
        onAfterBinding: function (oContext) {
          if (!oContext) return;
          var that = this;
          oContext.requestObject("slug").then(function (sSlug) {
            if (!sSlug) return;
            that._loadBranchPerformance(sSlug);
          });
        }
      }
    },

    // --- Path Items "Task" column value help (#426) ---

    // Display text for the Task cell: the picked tutorial/group title, the
    // checkpoint title, or a "(select …)" prompt. Formatter -> raw values, no coercion.
    formatTaskDisplay: function (sTaskType, sTutorialTitle, sGroupTitle, sCheckpointTitle) {
      if (sTaskType === "TUTORIAL")   return sTutorialTitle || "(select tutorial)";
      if (sTaskType === "GROUP")      return sGroupTitle    || "(select group)";
      if (sTaskType === "CHECKPOINT") return sCheckpointTitle || "";
      return "";
    },

    formatTaskPlaceholder: function (sTaskType) {
      if (sTaskType === "TUTORIAL")   return "Click value help to pick a tutorial";
      if (sTaskType === "GROUP")      return "Click value help to pick a group";
      if (sTaskType === "CHECKPOINT") return "Type checkpoint title";
      return "Pick a task type first";
    },

    // Show the F4 icon for TUTORIAL/GROUP rows (which have a picker); hide it for
    // CHECKPOINT (free-text) and unset rows. Formatter receives the raw String
    // taskType — no Boolean coercion of the bound part.
    formatTaskShowValueHelp: function (sTaskType) {
      return sTaskType === "TUTORIAL" || sTaskType === "GROUP";
    },

    onTaskValueHelp: function (oEvent) {
      var oInput = oEvent.getSource();
      var oContext = oInput.getBindingContext();
      if (!oContext) return;
      var sType = oContext.getProperty("taskType");
      if (sType === "TUTORIAL") {
        _openPicker(oInput, "Tutorials");
      } else if (sType === "GROUP") {
        _openPicker(oInput, "Groups");
      }
    },

    onTaskCheckpointChange: function (oEvent) {
      var oInput = oEvent.getSource();
      var oContext = oInput.getBindingContext();
      if (!oContext) return;
      if (oContext.getProperty("taskType") !== "CHECKPOINT") return;
      oContext.setProperty("checkpointTitle", oEvent.getParameter("value") || "");
    },

    _loadBranchPerformance: function (sSlug) {
      var sFilter = encodeURIComponent("missionSlug eq '" + sSlug.replace(/'/g, "''") + "'");
      var sUrl  = "/admin/analytics/AnalyticsBranchPerformance?$filter=" + sFilter + "&$top=200";
      var sUrl2 = "/admin/analytics/AnalyticsBranchTopPick?$filter="     + sFilter + "&$top=400";
      var oModel = this.base.getView().getModel("branchPerf");
      Promise.all([
        fetch(sUrl,  { credentials: "include", headers: { Accept: "application/json" } }).then(function (r) { return r.json(); }),
        fetch(sUrl2, { credentials: "include", headers: { Accept: "application/json" } }).then(function (r) { return r.json(); })
      ]).then(function (parts) {
        var perf = (parts[0] && parts[0].value) || [];
        var top  = (parts[1] && parts[1].value) || [];
        oModel.setData(mergeBranchPerf(perf, top));
      }).catch(function () {
        // Silent on failure — section just shows the IllustratedMessage no-data state.
      });
    }
  });
});
