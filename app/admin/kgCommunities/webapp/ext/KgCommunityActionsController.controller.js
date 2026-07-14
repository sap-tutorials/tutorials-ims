// app/admin/kgCommunities/webapp/ext/KgCommunityActionsController.controller.js
//
// Curator-assist promote-time nudge for the KG Communities LR + OP (#1172).
//
// Implemented as a ControllerExtension (mirrors app/admin/tags/webapp/ext/
// TagImportController.controller.js). The manifest registers this under
// sap.ui.controllerExtensions with controllerName
// "sap.tutorials.admin.kgCommunities.ext.KgCommunityActionsController" —
// NO ".controller" in the dotted name; the FE loader appends ".controller.js"
// to resolve the file. press refs use the same dotted name.
//
// Inside a ControllerExtension, this.base is the FE page controller, so
// this.base.editFlow and this.base.getView() are available (same access path
// as TagImportController uses this.base.getView() / this.base.extensionAPI).
//
// SuperAdmin gating is unchanged and authoritative on the server
// (@requires:'SuperAdmin' in srv/admin-service.cds). This warning is advisory.
sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension",
  "sap/m/MessageBox"
], function (ControllerExtension, MessageBox) {
  "use strict";

  // FE V4 hands the handler either an array [context], a single Context, or a
  // UI5 Event depending on LR-toolbar vs OP-header invocation. Resolve all.
  // Module-level (not on the extension object) so it is pure and testable.
  function resolveCtx(arg) {
    if (!arg) return null;
    if (Array.isArray(arg)) return arg[0] || null;
    if (typeof arg.getModel === "function") return arg;
    if (typeof arg.getSource === "function") {
      var src = arg.getSource();
      if (src && typeof src.getBindingContext === "function") return src.getBindingContext();
    }
    return null;
  }

  var ACTION = "AdminService.promoteCommunityToMission";

  return ControllerExtension.extend("sap.tutorials.admin.kgCommunities.ext.KgCommunityActionsController", {

    onPromoteToMission: function (arg) {
      var ctx = resolveCtx(arg);
      var view = this.base.getView();
      var bundle = view && view.getModel("i18n") && view.getModel("i18n").getResourceBundle();

      // Capture the "Promote anyway" label once — used both in actions array
      // and in the onClose comparison to avoid getText() inconsistency (I1 fix).
      var promoteAnyway = bundle ? bundle.getText("promoteAnyway") : "Promote anyway";

      var self = this;

      var invoke = function () {
        // Opens FE's standard parameter dialog for the unbound action.
        // For an unbound parameterized action, contexts is not required —
        // the dialog collects communityId/missionSlug/title directly.
        self.base.editFlow.invokeAction(ACTION, {
          model: view.getModel()
        });
      };

      // Guard: only call getProperty when ctx is non-null (m3 fix).
      var high = ctx && ctx.getProperty && ctx.getProperty("coverageHigh");
      if (!high) {
        invoke();
        return;
      }

      var pct = ctx.getProperty("missionCoveragePct") != null ? ctx.getProperty("missionCoveragePct") : "?";
      var mission = ctx.getProperty("dominantMissionTitle") || "an existing mission";
      var msg = bundle
        ? bundle.getText("promoteHighCoverageWarning", [pct, mission])
        : "~" + pct + "% of this community's tutorials are already in \"" + mission +
          "\". Consider extending that mission instead of creating a new one.";

      MessageBox.warning(msg, {
        title: bundle ? bundle.getText("promoteHighCoverageTitle") : "High mission overlap",
        actions: [
          promoteAnyway,
          MessageBox.Action.CANCEL
        ],
        emphasizedAction: MessageBox.Action.CANCEL,
        onClose: function (choice) {
          if (choice === promoteAnyway) {
            invoke();
          }
        }
      });
    }

  });
});
