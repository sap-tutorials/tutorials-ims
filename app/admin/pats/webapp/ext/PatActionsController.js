// app/admin/pats/webapp/ext/PatActionsController.js
//
// Plain UI5 module for the MyPATs List Report "Mint Token" toolbar action
// (`onMintToken`). See #1132.
//
// Why NOT a ControllerExtension: Fiori Elements v4 resolves `press`
// references in manifest action config as PLAIN modules (loader path
// `<dotted-name>.js`), NOT as controller extensions (loader path
// `<dotted-name>.controller.js`). The `.controller.js` sibling stays
// registered via controllerExtensions[ListReportController].controllerName
// so its `onInit` no-op runs at view bootstrap (UI5 requires the registered
// file to exist), but ALL dialog logic lives here. Same bug class + fix as
// TagImportController (#539). Guarded by scripts/check-ui5-controller-extensions.ts.
//
// === Flow ===
//   Mint Token toolbar button → onMintToken → MintDialog.fragment (name /
//   scopes / ttlDays) → onMintConfirm → PatService.mintPAT bound-operation →
//   MintedTokenDialog.fragment shows the plaintext token ONCE (copy-to-
//   clipboard; never persisted or re-shown) → onMintedClose refreshes the list.
//
// revokePAT is a BOUND line-item action (DataFieldForAction in
// app/admin-annotations.cds) with a built-in confirmation via
// @Common.IsActionCritical — no controller code needed for revoke.
sap.ui.define([
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Fragment, JSONModel, MessageBox, MessageToast) {
  "use strict";

  // Module-level state — the List Report view is a singleton, so caching the
  // resolved view + dialogs across presses is safe.
  let _resolvedView = null;
  let _mintDialog = null;
  let _mintedDialog = null;

  function _initialMintState() {
    return { name: "", scopes: ["read"], ttlDays: 90 };
  }

  // Resolve the active List Report view from whatever shape FE V4 hands the
  // press handler (UI5 Event → getSource; else fall back to the known
  // container-<app>---<view> id). Mirrors TagImportController._resolveView.
  function _resolveView(arg) {
    if (_resolvedView) return _resolvedView;
    let candidate = null;
    if (arg && typeof arg.getSource === "function") {
      candidate = arg.getSource();
      while (candidate && !candidate.isA("sap.ui.core.mvc.View")) {
        candidate = candidate.getParent && candidate.getParent();
      }
    }
    if (!candidate) {
      candidate = sap.ui.getCore().byId(
        "container-sap.tutorials.admin.pats---sap.fe.templates.ListReport.view.ListReport"
      );
    }
    _resolvedView = candidate || null;
    return _resolvedView;
  }

  function _bundle(view) {
    return view.getModel("i18n").getResourceBundle();
  }

  function _refreshList(view) {
    // Prefer the FE extension API when available (set by the .controller.js
    // sibling); else refresh the inner table binding directly.
    const lr = view.byId("fe::table::MyPATs::LineItem-innerTable");
    if (lr && lr.getBinding("items")) lr.getBinding("items").refresh();
  }

  const handlers = {

    // Toolbar button press. `arg` is a UI5 Event (sap.m.Button) or a context
    // array (FE V4 default toolbar handler) — _resolveView handles both.
    onMintToken: function (arg) {
      const view = _resolveView(arg);
      if (!view) {
        MessageBox.error("Could not resolve the List Report view. Reload and try again.");
        return;
      }
      let model = view.getModel("mint");
      if (!model) {
        model = new JSONModel(_initialMintState());
        view.setModel(model, "mint");
      } else {
        model.setData(_initialMintState());
      }
      if (_mintDialog) {
        _mintDialog.open();
        return;
      }
      Fragment.load({
        id: view.getId(),
        name: "sap.tutorials.admin.pats.ext.MintDialog",
        controller: handlers
      }).then(function (dlg) {
        _mintDialog = dlg;
        view.addDependent(dlg);
        dlg.open();
      });
    },

    onMintConfirm: function () {
      const view = _resolvedView;
      if (!view) return;
      const bundle = _bundle(view);
      const data = view.getModel("mint").getData();

      const name = (data.name || "").trim();
      if (!name) { MessageBox.error(bundle.getText("mint.errorNameRequired")); return; }
      const scopes = Array.isArray(data.scopes) ? data.scopes : [];
      if (scopes.length === 0) { MessageBox.error(bundle.getText("mint.errorScopesRequired")); return; }
      const ttlDays = Number(data.ttlDays) || 90;

      // Bound-operation via the OData V4 model — same transport the tags app
      // uses for previewTagImport/commitTagImport. FE handles CSRF + $batch.
      const op = view.getModel().bindContext("/mintPAT(...)");
      op.setParameter("name", name);
      op.setParameter("scopes", scopes);
      op.setParameter("ttlDays", ttlDays);
      op.execute().then(function () {
        const result = op.getBoundContext().getObject();
        if (_mintDialog) _mintDialog.close();
        handlers._showMintedToken(view, result);
        _refreshList(view);
      }).catch(function (err) {
        const detail = (err && err.error && err.error.message) || (err && err.message) || String(err);
        MessageBox.error(bundle.getText("mint.errorGeneric", [detail]));
      });
    },

    onMintCancel: function () {
      if (_mintDialog) _mintDialog.close();
    },

    // Show the plaintext token exactly once. Stored ONLY in a transient JSON
    // model tied to the dialog; cleared on close so it doesn't linger.
    _showMintedToken: function (view, result) {
      let model = view.getModel("minted");
      if (!model) {
        model = new JSONModel({});
        view.setModel(model, "minted");
      }
      model.setData({ token: result.token || "", prefix: result.prefix || "" });

      const open = function (dlg) { dlg.open(); };
      if (_mintedDialog) { open(_mintedDialog); return; }
      Fragment.load({
        id: view.getId(),
        name: "sap.tutorials.admin.pats.ext.MintedTokenDialog",
        controller: handlers
      }).then(function (dlg) {
        _mintedDialog = dlg;
        view.addDependent(dlg);
        open(dlg);
      });
    },

    onCopyToken: function () {
      const view = _resolvedView;
      if (!view) return;
      const bundle = _bundle(view);
      const token = view.getModel("minted").getProperty("/token") || "";
      const done = function () { MessageToast.show(bundle.getText("minted.copied")); };
      const fail = function () { MessageBox.information(bundle.getText("minted.copyFailed")); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(token).then(done).catch(fail);
      } else {
        fail();
      }
    },

    onMintedClose: function () {
      if (_mintedDialog) _mintedDialog.close();
    },

    // Fires on every close path (Done button, ESC, tap-outside). Wipe the
    // plaintext from the transient model so it never lingers or re-shows.
    onMintedAfterClose: function () {
      const view = _resolvedView;
      if (view) {
        const model = view.getModel("minted");
        if (model) model.setData({});
      }
    }

  };

  return handlers;
});
