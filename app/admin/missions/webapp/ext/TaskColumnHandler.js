sap.ui.define([
  "sap/m/SelectDialog",
  "sap/m/StandardListItem",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/json/JSONModel"
], function (SelectDialog, StandardListItem, Filter, FilterOperator, JSONModel) {
  "use strict";

  function _displayFor(taskType, tutorialTitle, groupTitle, checkpointTitle) {
    if (taskType === "TUTORIAL")   return tutorialTitle || "(select tutorial)";
    if (taskType === "GROUP")      return groupTitle    || "(select group)";
    if (taskType === "CHECKPOINT") return checkpointTitle || "";
    return "";
  }

  function _placeholderFor(taskType) {
    if (taskType === "TUTORIAL")   return "Click value help to pick a tutorial";
    if (taskType === "GROUP")      return "Click value help to pick a group";
    if (taskType === "CHECKPOINT") return "Type checkpoint title";
    return "Pick a task type first";
  }

  function _openPicker(oInput, sEntitySet, sTitleField, sIdField) {
    var oContext = oInput.getBindingContext();
    if (!oContext) return;
    var oODataModel = oContext.getModel();

    var oDialog = new SelectDialog({
      title: "Select " + (sEntitySet === "Tutorials" ? "Tutorial" : "Group"),
      noDataText: "No matches",
      growing: true,
      growingThreshold: 50,
      search: function (oEvent) {
        var sQuery = oEvent.getParameter("value") || "";
        var oBinding = oEvent.getSource().getBinding("items");
        if (!oBinding) return;
        if (sQuery) {
          oBinding.filter([new Filter(sTitleField, FilterOperator.Contains, sQuery)]);
        } else {
          oBinding.filter([]);
        }
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

    var oLocal = new JSONModel({ items: [] });
    oDialog.setModel(oLocal);

    var oList = oODataModel.bindList("/" + sEntitySet, undefined, undefined, undefined, {
      $select: "ID," + sTitleField,
      $$ownRequest: true
    });
    oList.requestContexts(0, 200).then(function (aContexts) {
      var aItems = aContexts.map(function (c) { return c.getObject(); });
      oLocal.setProperty("/items", aItems);
      oDialog.bindAggregation("items", {
        path: "/items",
        template: new StandardListItem({
          title: "{" + sTitleField + "}",
          description: "{ID}"
        })
      });
    }).catch(function (e) {
      // surface a placeholder row so the user knows the request failed
      oLocal.setProperty("/items", [{ ID: "", title: "Error loading: " + (e && e.message || e) }]);
    });

    oDialog.open();
  }

  return {
    formatTaskDisplay: _displayFor,
    formatPlaceholder: _placeholderFor,

    onTaskValueHelp: function (oEvent) {
      var oInput = oEvent.getSource();
      var oContext = oInput.getBindingContext();
      if (!oContext) return;
      var sType = oContext.getProperty("taskType");
      if (sType === "TUTORIAL") {
        _openPicker(oInput, "Tutorials", "title", "ID");
      } else if (sType === "GROUP") {
        _openPicker(oInput, "Groups", "title", "ID");
      }
    },

    onCheckpointChange: function (oEvent) {
      var oInput = oEvent.getSource();
      var oContext = oInput.getBindingContext();
      if (!oContext) return;
      var sType = oContext.getProperty("taskType");
      if (sType !== "CHECKPOINT") return;
      var sValue = oEvent.getParameter("value") || "";
      oContext.setProperty("checkpointTitle", sValue);
    }
  };
});
