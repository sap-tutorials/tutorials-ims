// app/admin/tutorials/webapp/ext/SourceMarkdownHandler.js
//
// Plain UI5 module for the Tutorials Object Page header action
// "Rebuild this tutorial" (manifest: header.actions.RebuildTutorialAction).
//
// Why NOT the ControllerExtension: Fiori Elements v4 resolves a manifest
// `press` reference as a PLAIN module (loader path `<dotted-name>.js`), NOT
// as a controller extension (`<dotted-name>.controller.js`). Wiring the press
// at the `.controller.js` produces a 404 at click time and the static guard
// `check-ui5-controller-extensions` fails the build. This mirrors the
// Concepts ConceptActionsController.js / AskJoule.js pattern (PR #537 / #405,
// memory `feedback_ui5_controller_suffix_collision`). The sibling
// SourceMarkdownHandler.controller.js keeps the Source-Markdown SECTION logic
// (both files share the base name; FE resolves each by suffix — same as
// Concepts' ConceptActionsController pair).
//
// FE V4 manifest-action handler signature (single argument): an OP header
// action is invoked with the page binding context (or a length-1 array of it),
// NOT a UI event — so there is no button to disable. resolveCtx() handles the
// context/array/legacy-event shapes; double-submit is prevented by a
// module-level in-flight guard plus the server's own `debounced` result flag.
sap.ui.define([
  "sap/m/MessageBox"
], function (MessageBox) {
  "use strict";

  // Resolve the binding context regardless of how FE V4 invoked the handler
  // (bound context, length-1 array, or legacy UI5 event). Mirrors the Concepts
  // resolveCtx + AskJoule _resolveBindingContext helpers.
  function resolveCtx(arg) {
    if (!arg) return null;
    if (typeof arg.getProperty === "function") return arg;              // a Context
    if (Array.isArray(arg) && arg.length) return arg[0];                // [context]
    if (typeof arg.getSource === "function") {                          // legacy UI5 Event
      var oControl = arg.getSource();
      var oBC = oControl && oControl.getBindingContext && oControl.getBindingContext();
      while (!oBC && oControl) {
        oControl = oControl.getParent && oControl.getParent();
        oBC = oControl && oControl.getBindingContext && oControl.getBindingContext();
      }
      return oBC || null;
    }
    return null;
  }

  // Module-level in-flight guard: a manifest press handler is not handed the
  // triggering button, so we can't disable it. This flag stops a second
  // dispatch of ANY tutorial while one request is in flight (the server also
  // debounces per-slug; this is the immediate client-side stop).
  var _rebuildInFlight = false;

  return {
    // Triggered by the "Rebuild this tutorial" header action.
    onRebuildTutorial: function (arg) {
      var oContext = resolveCtx(arg);
      if (!oContext) {
        MessageBox.error("No tutorial bound to this view.");
        return;
      }
      if (_rebuildInFlight) {
        MessageBox.information("A rebuild request is already in progress — please wait for it to finish.");
        return;
      }

      var oModel = oContext.getModel();
      var oData = (typeof oContext.getObject === "function" && oContext.getObject()) || {};
      var sTitle = oData.title || oData.slug || "(this tutorial)";

      // i18n is on the context's "i18n" model; fall back to literal text if
      // the bundle can't be resolved from this plain module.
      function t(key, args, fallback) {
        try {
          var oI18n = oContext.getModel("i18n");
          var rb = oI18n && oI18n.getResourceBundle && oI18n.getResourceBundle();
          if (rb) return rb.getText(key, args);
        } catch (e) { /* fall through */ }
        return fallback;
      }

      var sDialogTitle    = t("RebuildTutorialDialogTitle", [], "Rebuild tutorial");
      var sDialogMessage  = t("RebuildTutorialDialogMessage", [sTitle],
        'Rebuild tutorial "' + sTitle + '"? This dispatches a workflow that re-validates and republishes the tutorial (about 2 minutes).');
      var sToastSuccess   = t("RebuildTutorialToastSuccess", [sTitle],
        'Rebuild dispatched for "' + sTitle + '" — the workflow was queued. In ~2 minutes, reload this page and check the "Active Quarantine" section for the outcome.');
      var sToastDebounced = t("RebuildTutorialToastDebounced", [sTitle],
        'A rebuild for "' + sTitle + '" was already in progress, so a new one was not queued.');
      var sToastError     = t("RebuildTutorialToastError", [""], "Could not dispatch rebuild:");

      MessageBox.confirm(sDialogMessage, {
        title: sDialogTitle,
        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
        emphasizedAction: MessageBox.Action.OK,
        onClose: function (sResult) {
          if (sResult !== MessageBox.Action.OK) return;

          _rebuildInFlight = true;
          var oAction = oModel.bindContext(
            "AdminService.rebuildContent(...)",
            oContext,
            { $$inheritExpandSelect: true }
          );

          oAction.execute().then(function () {
            // Dispatch accepted != rebuild done. The bound action returns
            // {dispatched, debounced} the moment the GitHub workflow_dispatch
            // is queued (fire-and-forget, srv/lib/rebuild-trigger.js). Show a
            // persistent dialog so the operator reads that the real outcome
            // lands in "Active Quarantine" (#2586), and refresh the context so
            // an already-current quarantine shows. When the server reports
            // `debounced`, say a rebuild was already in flight.
            var bDebounced = false;
            try {
              var oResult = oAction.getBoundContext() && oAction.getBoundContext().getObject();
              bDebounced = !!(oResult && oResult.debounced === true && oResult.dispatched === false);
            } catch (e) { /* best-effort */ }
            try { oContext.refresh(); } catch (e) { /* best-effort */ }
            _rebuildInFlight = false;
            MessageBox.information(bDebounced ? sToastDebounced : sToastSuccess, { title: sDialogTitle });
          }).catch(function (err) {
            _rebuildInFlight = false;
            var msg = (err && err.message) ? err.message : String(err);
            MessageBox.error(sToastError + " " + msg);
          });
        }
      });
    }
  };
});
