// app/admin/topicClusters/webapp/ext/TopicClusterActionsController.js
//
// Plain UI5 module for the Topic Clusters LR + OP toolbar actions.
//
// Why NOT a ControllerExtension: Fiori Elements V4 resolves manifest `press`
// references as plain modules ("<dotted-name>.js"), not controller extensions
// ("<dotted-name>.controller.js"). The sibling .controller.js is a no-op CE
// registered so UI5 can satisfy the `controllerExtensions` manifest entry at
// view bootstrap.
//
// VIEW-AGNOSTIC: these handlers do NOT resolve a view. OData model is taken
// from the row context (ctx.getModel()), i18n from a locally-constructed
// ResourceModel, dialogs are standalone (no view.addDependent).
//
// --- #1558 GOTCHA: admin-shell passes arg===undefined to LR toolbar handlers ---
// Inside the admin-shell sap.tnt.ToolPage componentUsage host, FE V4 invokes
// manifest LineItem `press` handlers with NO ARGUMENT (undefined) even when a
// row is selected. The simple `if (!arg) return null` pattern (used in
// kgCommunities) therefore always fires the "no row selected" error from the
// List Report toolbar. The fix (Direction-C from PR #1558) is:
//   1. If arg is a non-empty context array → use arg[0] (OP / correctly-passed).
//   2. Else, recover selection from this app's sap.ui.mdc.Table via the
//      Element registry, keyed on the entity path /TopicClustersAdmin.
//   3. Only if BOTH yield nothing → genuine "select a row first" message.
// This intentionally DIVERGES from kgCommunities, which has the same latent
// bug but is left for a separate change.
//
// Actions:
//   onOverrideLabel — opens an input dialog, calls overrideTopicLabel(slug, label)
//   onToggleHidden  — calls setTopicClusterHidden(slug, !currentHidden)

sap.ui.define([
  "sap/ui/core/Element",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/resource/ResourceModel",
  "sap/m/Dialog",
  "sap/m/Label",
  "sap/m/Input",
  "sap/m/Button",
  "sap/m/VBox",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Element, JSONModel, ResourceModel, Dialog, Label, Input, Button, VBox, MessageBox, MessageToast) {
  "use strict";

  // The OData entity path this app's List Report table binds to.
  // Used by _selectedFromTable to key the correct mdc.Table in the Element
  // registry — see #1558 Direction-C comment at the top of this file.
  const LR_ENTITY_PATH = "/TopicClustersAdmin";

  // Module-level state — see KgCommunityActionsController.js for rationale.
  let _dialog = null;
  let _odataModel = null;
  let _i18nBundle = null;

  // ---------------------------------------------------------------------------
  // i18n — local ResourceModel, no view required.
  // ---------------------------------------------------------------------------

  function _getBundle() {
    if (!_i18nBundle) {
      const rm = new ResourceModel({
        bundleName: "sap.tutorials.admin.topicClusters.i18n.i18n"
      });
      _i18nBundle = rm.getResourceBundle();
    }
    return _i18nBundle;
  }

  // ---------------------------------------------------------------------------
  // #1558 Direction-C: Element-registry table selection recovery.
  //
  // When the admin-shell passes arg===undefined, read the selection directly
  // from this app's sap.ui.mdc.Table via the Element registry, keyed on the
  // row-binding entity path. Fail-quiet (returns [] on any error) so a
  // registry or table-shape change never re-crashes the handler.
  // ---------------------------------------------------------------------------

  function _selectedFromTable() {
    let ctxs = [];
    try {
      Element.registry.forEach(function (el) {
        if (ctxs.length) return;
        if (!el.isA || !el.isA("sap.ui.mdc.Table")) return;
        try {
          const b = el.getRowBinding && el.getRowBinding();
          if (b && b.getPath && b.getPath() === LR_ENTITY_PATH &&
              typeof el.getSelectedContexts === "function") {
            const c = el.getSelectedContexts();
            if (Array.isArray(c) && c.length > 0) ctxs = c;
          }
        } catch (e) { /* fail-quiet per table */ }
      });
    } catch (e) { /* registry unavailable */ }
    return ctxs;
  }

  // ---------------------------------------------------------------------------
  // resolveSelectedContext — pure helper; dependency-injected tableLookupFn
  // makes it unit-testable without a real UI5 runtime.
  //
  // Resolution order (#1558 Direction-C):
  //   1. arg is a non-empty context array  → use arg[0]   (OP / correct FE arg)
  //   2. arg is a single Context object    → use directly
  //   3. arg is a UI5 Event               → getSource().getBindingContext()
  //   4. anything else (incl. undefined)  → recover from tableLookupFn
  //
  // tableLookupFn(entityPath) → Context[]  (injected; real path uses Element.registry)
  // Returns null if no context can be found — caller shows "select a row first".
  // ---------------------------------------------------------------------------

  function resolveSelectedContext(arg, tableLookupFn) {
    // Case 1: array of contexts (LR multi-select or correctly-passed OP arg).
    if (Array.isArray(arg) && arg.length > 0) return arg[0];

    // Case 2: single Context object already (has both getModel and getPath).
    if (arg && typeof arg.getModel === "function" && typeof arg.getPath === "function") {
      return arg;
    }

    // Case 3: UI5 Event — getSource().getBindingContext().
    if (arg && typeof arg.getSource === "function") {
      const src = arg.getSource();
      if (src && typeof src.getBindingContext === "function") {
        const ctx = src.getBindingContext();
        if (ctx) return ctx;
      }
    }

    // Case 4: admin-shell passes undefined — recover via Element registry (#1558).
    try {
      const ctxs = tableLookupFn(LR_ENTITY_PATH);
      if (Array.isArray(ctxs) && ctxs.length > 0) return ctxs[0];
    } catch (e) { /* fail-quiet */ }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Label override dialog — programmatically built (no Fragment XML needed for
  // a single-input dialog; keeps the file self-contained).
  // ---------------------------------------------------------------------------

  function _openLabelDialog(slug, currentLabel) {
    const bundle = _getBundle();

    const viewState = new JSONModel({
      slug: slug,
      label: currentLabel || "",
      busy: false
    });

    // Recreate on every open so bindings are always fresh.
    if (_dialog && !_dialog.bIsDestroyed) {
      _dialog.destroy();
    }
    _dialog = null;

    const inputField = new Input({
      value: "{viewState>/label}",
      placeholder: "Enter custom label…",
      width: "100%"
    });

    _dialog = new Dialog({
      title: bundle ? bundle.getText("overrideLabelDialogTitle") : "Override Topic Cluster Label",
      content: [
        new VBox({
          items: [
            new Label({ text: bundle ? bundle.getText("overrideLabelInputLabel") : "Custom label", labelFor: inputField }),
            inputField
          ]
        })
      ],
      beginButton: new Button({
        text: bundle ? bundle.getText("overrideLabelConfirm") : "Save Label",
        type: "Emphasized",
        press: handlers.onLabelConfirm
      }),
      endButton: new Button({
        text: bundle ? bundle.getText("overrideLabelCancel") : "Cancel",
        press: handlers.onLabelCancel
      }),
      afterClose: function () {
        if (_dialog && !_dialog.bIsDestroyed) {
          _dialog.destroy();
          _dialog = null;
        }
      }
    });

    _dialog.setModel(viewState, "viewState");
    _dialog.open();
  }

  // ---------------------------------------------------------------------------
  // Handlers object — the `press` references in manifest resolve to properties
  // of this object (FE loads the module and calls `module.<handlerName>(arg)`).
  // ---------------------------------------------------------------------------

  const handlers = {

    // Exposed for unit tests to exercise resolver paths without a UI5 runtime.
    _resolveSelectedContext: resolveSelectedContext,

    onOverrideLabel: function (arg) {
      const ctx = resolveSelectedContext(arg, _selectedFromTable);
      const bundle = _getBundle();

      if (!ctx) {
        const msg = bundle
          ? bundle.getText("noClusterSelected")
          : "No topic cluster selected. Please select a row first.";
        MessageBox.error(msg);
        return;
      }

      _odataModel = ctx.getModel();
      const slug = ctx.getProperty("slug");
      const curatedLabel = ctx.getProperty("curatedLabel") || "";

      _openLabelDialog(slug, curatedLabel);
    },

    onLabelConfirm: function () {
      if (!_dialog || _dialog.bIsDestroyed) return;

      const model = _dialog.getModel("viewState");
      const bundle = _getBundle();
      const slug = model.getProperty("/slug");
      const label = (model.getProperty("/label") || "").trim();

      if (!label) {
        const msg = bundle ? bundle.getText("overrideLabelRequired") : "A label value is required.";
        MessageBox.warning(msg);
        return;
      }

      if (!_odataModel) {
        MessageBox.error("No service model available. Please reload and try again.");
        return;
      }

      model.setProperty("/busy", true);

      const op = _odataModel.bindContext("/overrideTopicLabel(...)");
      op.setParameter("slug", slug);
      op.setParameter("label", label);

      op.execute().then(function () {
        model.setProperty("/busy", false);
        if (_dialog && !_dialog.bIsDestroyed) _dialog.close();

        const msg = bundle ? bundle.getText("overrideLabelSuccess") : "Label override saved successfully.";
        MessageToast.show(msg);

        try {
          if (_odataModel && _odataModel.refresh) _odataModel.refresh();
        } catch (e) { /* non-fatal */ }
      }).catch(function (err) {
        model.setProperty("/busy", false);
        const detail = (err && err.error && err.error.message)
          || (err && err.message) || String(err);
        MessageBox.error(detail);
      });
    },

    onLabelCancel: function () {
      if (_dialog && !_dialog.bIsDestroyed) _dialog.close();
    },

    onToggleHidden: function (arg) {
      const ctx = resolveSelectedContext(arg, _selectedFromTable);
      const bundle = _getBundle();

      if (!ctx) {
        const msg = bundle
          ? bundle.getText("noClusterSelected")
          : "No topic cluster selected. Please select a row first.";
        MessageBox.error(msg);
        return;
      }

      const odataModel = ctx.getModel();
      const slug = ctx.getProperty("slug");
      const currentHidden = ctx.getProperty("hidden") === true;
      const newHidden = !currentHidden;

      const op = odataModel.bindContext("/setTopicClusterHidden(...)");
      op.setParameter("slug", slug);
      op.setParameter("hidden", newHidden);

      op.execute().then(function () {
        const msg = bundle ? bundle.getText("toggleHiddenSuccess") : "Visibility updated successfully.";
        MessageToast.show(msg);

        try {
          if (odataModel && odataModel.refresh) odataModel.refresh();
        } catch (e) { /* non-fatal */ }
      }).catch(function (err) {
        const detail = (err && err.error && err.error.message)
          || (err && err.message) || String(err);
        MessageBox.error(detail);
      });
    }

  };

  return handlers;
});
