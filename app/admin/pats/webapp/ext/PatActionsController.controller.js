// app/admin/pats/webapp/ext/PatActionsController.controller.js
//
// ControllerExtension sibling for the MyPATs List Report (#1132).
//
// Registered via manifest.json controllerExtensions[ListReportController].
// UI5 requires the registered file to exist at bootstrap, so this stub's
// no-op onInit runs at view load. ALL "Mint Token" toolbar-action logic lives
// in the plain-module sibling PatActionsController.js — FE V4 resolves the
// manifest `press:` reference as a plain module (`.js`), not a controller
// extension (`.controller.js`). Keeping both files satisfies both loader
// paths and the scripts/check-ui5-controller-extensions.ts guard (#362/#539).
sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension"
], function (ControllerExtension) {
  "use strict";

  return ControllerExtension.extend("sap.tutorials.admin.pats.ext.PatActionsController", {
    override: {
      onInit: function () {}
    }
  });
});
