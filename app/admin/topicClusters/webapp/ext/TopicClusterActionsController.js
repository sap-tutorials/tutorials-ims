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
// VIEW-AGNOSTIC: these handlers do NOT resolve a view. Mirrors the
// KgCommunityActionsController.js pattern — the OData model is taken from
// the row context (ctx.getModel()), i18n from a locally-constructed
// ResourceModel, and any dialog is standalone (no view.addDependent).
//
// Actions:
//   onOverrideLabel — opens an input dialog, calls overrideTopicLabel(slug, label)
//   onToggleHidden  — calls setTopicClusterHidden(slug, !current hidden value)

sap.ui.define([
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/resource/ResourceModel",
  "sap/m/Dialog",
  "sap/m/Label",
  "sap/m/Input",
  "sap/m/Button",
  "sap/m/VBox",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (JSONModel, ResourceModel, Dialog, Label, Input, Button, VBox, MessageBox, MessageToast) {
  "use strict";

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
  // Context resolution — mirrors KgCommunityActionsController._resolveCtx.
  // Handles all FE V4 press-arg shapes:
  //   - array of contexts (LR multi-select toolbar): use first element
  //   - single Context object (OP page context)
  //   - UI5 Event (OP header button): getSource().getBindingContext()
  // ---------------------------------------------------------------------------

  function _resolveCtx(arg) {
    if (!arg) return null;
    if (Array.isArray(arg)) return arg[0] || null;
    if (typeof arg.getModel === "function") return arg;   // already a Context
    if (typeof arg.getSource === "function") {
      const src = arg.getSource();
      if (src && typeof src.getBindingContext === "function") {
        return src.getBindingContext();
      }
    }
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

    onOverrideLabel: function (arg) {
      const ctx = _resolveCtx(arg);
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

        // Refresh best-effort so the updated effectiveLabel shows immediately.
        try {
          if (_odataModel && _odataModel.refresh) _odataModel.refresh();
        } catch (e) {
          // Non-fatal.
        }
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
      const ctx = _resolveCtx(arg);
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

        // Refresh best-effort so the updated hidden flag reflects immediately.
        try {
          if (odataModel && odataModel.refresh) odataModel.refresh();
        } catch (e) {
          // Non-fatal.
        }
      }).catch(function (err) {
        const detail = (err && err.error && err.error.message)
          || (err && err.message) || String(err);
        MessageBox.error(detail);
      });
    }

  };

  return handlers;
});
