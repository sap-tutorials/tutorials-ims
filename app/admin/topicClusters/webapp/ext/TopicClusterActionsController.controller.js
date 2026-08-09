// app/admin/topicClusters/webapp/ext/TopicClusterActionsController.controller.js
//
// Registered ControllerExtension (NO-OP) for the Topic Clusters LR + OP.
//
// Why this file exists: Fiori Elements V4 requires the file referenced by
// `sap.ui.controllerExtensions[...].controllerName` to be present at view
// bootstrap. FE resolves it by appending ".controller.js" to the dotted name.
//
// ALL real dialog logic lives in the sibling plain module
// TopicClusterActionsController.js — that is what manifest `press` actually
// loads (FE resolves press refs as plain "<dotted-name>.js", NOT ".controller.js").
//
// Mirror of app/admin/kgCommunities/webapp/ext/KgCommunityActionsController.controller.js.
sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension"
], function (ControllerExtension) {
  "use strict";

  return ControllerExtension.extend(
    "sap.tutorials.admin.topicClusters.ext.TopicClusterActionsController", {
    override: {
      onInit: function () {}
    }
  });
});
