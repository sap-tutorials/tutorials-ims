// app/admin/kgCommunities/webapp/ext/KgCommunityActionsController.controller.js
//
// Registered ControllerExtension (NO-OP) for the KG Communities LR + OP (#1172).
//
// Why this file exists: Fiori Elements V4 requires the file referenced by
// `sap.ui.controllerExtensions[...].controllerName` to be present at view
// bootstrap. FE resolves it by appending ".controller.js" to the dotted name.
//
// ALL real dialog logic lives in the sibling plain module
// KgCommunityActionsController.js — that is what manifest `press` actually loads
// (FE resolves press refs as plain "<dotted-name>.js", NOT ".controller.js").
//
// Mirror of app/admin/tags/webapp/ext/TagImportController.controller.js.
sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension"
], function (ControllerExtension) {
  "use strict";

  return ControllerExtension.extend(
    "sap.tutorials.admin.kgCommunities.ext.KgCommunityActionsController", {
    override: {
      onInit: function () {
        this._promoteDialog = null;
      }
    }
  });
});
