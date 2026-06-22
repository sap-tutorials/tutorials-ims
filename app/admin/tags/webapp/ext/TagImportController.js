// app/admin/tags/webapp/ext/TagImportController.js
//
// Plain UI5 module for the Tags List Report toolbar action
// (`openTagImportDialog`).
//
// Why NOT a ControllerExtension: Fiori Elements v4 resolves `press`
// references in manifest action config as plain modules (loader path
// `<dotted-name>.js`), not as controller extensions (loader path
// `<dotted-name>.controller.js`). The original implementation lived
// in `TagImportController.controller.js` only and produced 404s when
// the user clicked "Import" (latent — the feature was never reachable
// from the UI before this fix).
//
// Issue: surfaced during #539 lint-extension work (2026-06-22). Same
// bug class as PR #537 (Concepts), #538 (Categories), and PR #405
// (Advocates). Memory: feedback_ui5_controller_suffix_collision.
//
// === Architecture ===
//
// This file owns the dialog lifecycle (open / file-select / preview /
// commit / back / close) entirely in a module-level closure. The
// `.controller.js` sibling stays registered via
// `controllerExtensions[ListReportController].controllerName` so its
// `onInit` no-op runs at view bootstrap (UI5 requires the file to exist
// when registered) — but ALL the dialog logic lives here. The Fragment
// (`TagImportDialog.fragment.xml`) is loaded with `controller: <this
// module's exports>` so its `<Button press="onClose"/>` etc. bind to
// the handlers below.
//
// View resolution: FE V4 press handlers for List Report toolbar actions
// pass either a UI5 Event (when wired via SAP UI sap.m.Button) or an
// array of selected contexts (for FE V4 default toolbar handlers).
// Both forms let us walk back to the View: event → getSource().getView();
// array → contexts[0].getModel() ... but for an empty/no-context
// case we fall back to sap.ui.getCore().byId() using the Component's
// root view ID.
sap.ui.define([
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox"
], function (Fragment, JSONModel, MessageBox) {
  "use strict";

  // Module-level state — survives across button presses, scoped to the
  // app's lifetime (List Report is a singleton view).
  let _dialog = null;
  let _resolvedView = null;

  function _initialState() {
    return {
      state: "upload",       // upload | preview | done
      uploadTab: "file",
      format: "csv",
      payload: "",
      rows: [],
      summaryText: "",
      summaryStripType: "Information",
      strategy: "upsert",
      resultText: "",
      token: null
    };
  }

  // Resolve the active view from any of the press-arg shapes FE V4 might
  // hand us. Caches the result; the List Report view is a singleton so
  // re-resolving on every press would be wasteful.
  function _resolveView(arg) {
    if (_resolvedView) return _resolvedView;
    let candidate = null;

    // Shape 1: UI5 Event with getSource() → button → walk up to View.
    if (arg && typeof arg.getSource === "function") {
      candidate = arg.getSource();
      while (candidate && !candidate.isA("sap.ui.core.mvc.View")) {
        candidate = candidate.getParent && candidate.getParent();
      }
    }

    // Shape 2: array of contexts (FE V4 default for List Report toolbar).
    if (!candidate && Array.isArray(arg) && arg.length > 0) {
      const ctx = arg[0];
      if (ctx && typeof ctx.getModel === "function") {
        // Walk back via the model's binding root — limited but worth a shot.
        // Most realistically falls through to the byId fallback below.
        const model = ctx.getModel();
        if (model && model.getProperty) {
          // No direct view-from-model API; skip.
        }
      }
    }

    // Shape 3: fallback — find the singleton List Report view via UI5 core.
    // The app's component ID convention is "container-<app-name>---<view>",
    // produced by FE V4's RootContainer. We search for any view registered
    // under the tags app namespace.
    if (!candidate) {
      const core = sap.ui.getCore();
      // sap.ui.getCore().getElementsByName or byId; we don't know the exact
      // ID, so iterate the controlled elements and find the first View
      // whose viewName matches sap.fe.templates.ListReport.ListReport.
      // Pragmatic: getEventBus is too indirect; just look up by known ID.
      // The default FE V4 ID pattern is: "container-<app>---<view>".
      candidate = core.byId("container-sap.tutorials.admin.tags---sap.fe.templates.ListReport.view.ListReport");
    }

    _resolvedView = candidate || null;
    return _resolvedView;
  }

  function _ensureViewState(view) {
    let model = view.getModel("viewState");
    if (!model) {
      model = new JSONModel(_initialState());
      view.setModel(model, "viewState");
    } else {
      model.setData(_initialState());
    }
    return model;
  }

  function _statusLabel(view, status) {
    const bundle = view.getModel("i18n").getResourceBundle();
    return bundle.getText("tagImport.status." + status);
  }

  function _statusState(status) {
    switch (status) {
      case "new":      return "Success";
      case "conflict": return "Warning";
      case "invalid":  return "Error";
      default:         return "None";
    }
  }

  function _fmtSummary(view, s) {
    const bundle = view.getModel("i18n").getResourceBundle();
    return bundle.getText("tagImport.summary", [s.new_, s.conflict, s.invalid, s.total]);
  }

  function _fmtResult(view, r) {
    const bundle = view.getModel("i18n").getResourceBundle();
    return bundle.getText("tagImport.result", [r.inserted, r.updated, r.skipped, r.total]);
  }

  function _fmtError(view, err) {
    const bundle = view.getModel("i18n").getResourceBundle();
    const detail = (err && err.error && err.error.message) || (err && err.message) || String(err);
    return bundle.getText("tagImport.error.generic", [detail]);
  }

  // The handlers object — also serves as the Fragment's controller, so its
  // methods can be referenced by `press="onCommit"` etc. in the fragment XML.
  const handlers = {

    openTagImportDialog: function (arg) {
      const view = _resolveView(arg);
      if (!view) {
        MessageBox.error("Could not resolve the List Report view to open the import dialog. Reload and try again.");
        return;
      }
      _ensureViewState(view);
      if (_dialog) {
        _dialog.open();
        return;
      }
      Fragment.load({
        id: view.getId(),
        name: "sap.tutorials.admin.tags.ext.TagImportDialog",
        controller: handlers
      }).then(function (dlg) {
        _dialog = dlg;
        view.addDependent(dlg);
        dlg.open();
      });
    },

    onFileSelected: function (oEvent) {
      const file = oEvent.getParameter("files") && oEvent.getParameter("files")[0];
      if (!file) return;
      const view = _resolvedView;
      if (!view) return;
      const model = view.getModel("viewState");
      const reader = new FileReader();
      reader.onload = function (e) {
        model.setProperty("/payload", e.target.result);
        const fmt = file.name.toLowerCase().endsWith(".json") ? "json" : "csv";
        model.setProperty("/format", fmt);
      };
      reader.readAsText(file);
    },

    onPreview: function () {
      const view = _resolvedView;
      if (!view) return;
      const model = view.getModel("viewState");
      const payload = model.getProperty("/payload");
      const format  = model.getProperty("/format");
      const odataModel = view.getModel();
      const op = odataModel.bindContext("/previewTagImport(...)");
      op.setParameter("payload", payload);
      op.setParameter("format",  format);
      op.execute().then(function () {
        const result = op.getBoundContext().getObject();
        model.setProperty("/token", result.token);
        model.setProperty("/rows", result.rows.map(function (r) {
          return Object.assign({}, r, {
            statusLabel: _statusLabel(view, r.status),
            statusState: _statusState(r.status)
          });
        }));
        const s = result.summary;
        model.setProperty("/summaryText", _fmtSummary(view, s));
        model.setProperty("/summaryStripType",
          s.invalid > 0 ? "Warning" : (s.conflict > 0 ? "Information" : "Success"));
        model.setProperty("/state", "preview");
      }).catch(function (err) { MessageBox.error(_fmtError(view, err)); });
    },

    onCommit: function () {
      const view = _resolvedView;
      if (!view) return;
      const model = view.getModel("viewState");
      const odataModel = view.getModel();
      const op = odataModel.bindContext("/commitTagImport(...)");
      op.setParameter("token", model.getProperty("/token"));
      op.setParameter("strategy", model.getProperty("/strategy"));
      op.execute().then(function () {
        const r = op.getBoundContext().getObject();
        model.setProperty("/resultText", _fmtResult(view, r));
        model.setProperty("/state", "done");
        // Refresh the List Report rows via the inner table binding.
        const lr = view.byId("fe::table::Tags::LineItem-innerTable");
        if (lr && lr.getBinding("items")) lr.getBinding("items").refresh();
      }).catch(function (err) {
        const status = err && err.error && err.error.code;
        if (status === "410" || /expired/i.test(err.message || "")) {
          model.setProperty("/state", "upload");
          MessageBox.warning(view.getModel("i18n").getResourceBundle().getText("tagImport.error.expired"));
          return;
        }
        MessageBox.error(_fmtError(view, err));
      });
    },

    onBack: function () {
      const view = _resolvedView;
      if (!view) return;
      view.getModel("viewState").setProperty("/state", "upload");
    },

    onClose: function () {
      if (_dialog) _dialog.close();
    }

  };

  return handlers;
});
