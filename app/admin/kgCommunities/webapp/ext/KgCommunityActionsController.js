// app/admin/kgCommunities/webapp/ext/KgCommunityActionsController.js
//
// Curator-assist promote-time nudge for the KG Communities LR + OP (#1172).
//
// Why a PLAIN module (loader path <dotted>.js), NOT a .controller.js:
// FE V4 resolves manifest `press` refs as plain modules. A .controller.js
// suffix 404s on click. See app/admin/concepts/webapp/ext/
// ConceptActionsController.js header + memory feedback_ui5_controller_suffix_collision.
//
// The Promote button is declared as a manifest custom action (see manifest.json
// controlConfiguration) wired to onPromoteToMission. When the row's
// server-computed coverageHigh flag is set, we interpose a MessageBox.warning
// ("~X% already in <mission> — extend it instead?") before invoking the
// existing unbound promoteCommunityToMission action via editFlow.invokeAction
// (which opens FE's standard parameter dialog for communityId/missionSlug/title).
//
// SuperAdmin gating is unchanged and authoritative on the server
// (@requires:'SuperAdmin' in srv/admin-service.cds). This warning is advisory.
sap.ui.define([
  "sap/m/MessageBox"
], function (MessageBox) {
  "use strict";

  // FE V4 hands the handler either an array [context], a single Context, or a
  // UI5 Event depending on LR-toolbar vs OP-header invocation. Resolve all.
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

  return {
    onPromoteToMission: function (arg) {
      var ctx = resolveCtx(arg);
      var editFlow = this.editFlow || (this.base && this.base.editFlow);
      var view = (this.base && this.base.getView && this.base.getView()) ||
                 (this.getView && this.getView());
      var bundle = view && view.getModel("i18n") && view.getModel("i18n").getResourceBundle();

      var invoke = function () {
        // Opens FE's standard parameter dialog for the unbound action.
        editFlow.invokeAction(ACTION, {
          contexts: ctx || undefined,
          model: view && view.getModel()
        });
      };

      var high = ctx && ctx.getProperty && ctx.getProperty("coverageHigh");
      if (!high) { invoke(); return; }

      var pct = (ctx.getProperty("missionCoveragePct") != null) ? ctx.getProperty("missionCoveragePct") : "?";
      var mission = ctx.getProperty("dominantMissionTitle") || "an existing mission";
      var msg = bundle
        ? bundle.getText("promoteHighCoverageWarning", [pct, mission])
        : "~" + pct + "% of this community's tutorials are already in \"" + mission +
          "\". Consider extending that mission instead of creating a new one.";

      MessageBox.warning(msg, {
        title: bundle ? bundle.getText("promoteHighCoverageTitle") : "High mission overlap",
        actions: [
          bundle ? bundle.getText("promoteAnyway") : "Promote anyway",
          MessageBox.Action.CANCEL
        ],
        emphasizedAction: MessageBox.Action.CANCEL,
        onClose: function (choice) {
          if (choice === (bundle ? bundle.getText("promoteAnyway") : "Promote anyway")) invoke();
        }
      });
    }
  };
});
