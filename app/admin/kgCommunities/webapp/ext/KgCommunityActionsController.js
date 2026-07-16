// app/admin/kgCommunities/webapp/ext/KgCommunityActionsController.js
//
// Plain UI5 module for the KG Communities LR + OP "Promote to Mission" toolbar
// action (#1172).
//
// Why NOT a ControllerExtension: Fiori Elements V4 resolves manifest `press`
// references as plain modules ("<dotted-name>.js"), not controller extensions
// ("<dotted-name>.controller.js"). The original implementation lived only in
// KgCommunityActionsController.controller.js and produced 404s on button click.
//
// Architecture: the sibling .controller.js is a registered no-op CE so UI5
// can resolve the `controllerExtensions` manifest registration at view
// bootstrap. This file owns ALL dialog logic. The Fragment
// (PromoteDialog.fragment.xml) is loaded WITHOUT a view host — see below.
//
// VIEW-AGNOSTIC (#1172, PR re-applying the gate-2 fix): these handlers do NOT
// resolve a view. The earlier revision fell back to a hardcoded standalone FE
// view id ("container-sap.tutorials.admin.kgCommunities---sap.fe.templates.
// ListReport.view.ListReport") which is ABSENT when the app runs as a
// componentUsage inside the admin-shell tnt ToolPage — the real ids are
// sap.tutorials.admin.kgCommunities::KgCommunitiesList / ::KgCommunityObjectPage.
// On both the LR toolbar (press-arg is a context array, no getSource) and the
// OP header (button sits in an overflow popover, detached from the view parent
// chain), view resolution failed → "Could not resolve the view". These
// handlers only ever needed three things — an OData model, an i18n bundle, and
// a dialog host — all obtainable without a view:
//   - OData model : from the press-arg binding context (ctx.getModel()).
//   - i18n bundle : from a locally-constructed ResourceModel.
//   - dialog host : the Dialog is standalone; models are set on it directly and
//                   it is NOT view.addDependent'ed. Mirrors the view-free
//                   `concepts` sibling (ConceptActionsController.js).
//
// Action invocation: bindContext("/promoteCommunityToMission(...)") on the
// OData model taken from the row context — the plain module has no this.base.
sap.ui.define([
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/resource/ResourceModel",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Fragment, JSONModel, ResourceModel, MessageBox, MessageToast) {
  "use strict";

  // Module-level state.
  // _dialog: destroyed + recreated on every open (lightweight, 2 inputs), so
  //   its {viewState>/...} bindings always resolve against a fresh model.
  // _odataModel: captured from the row context at open time; reused by
  //   onPromoteConfirm to invoke the bound action and refresh afterwards.
  // _i18nBundle: lazily-built ResourceModel bundle, shared across opens.
  let _dialog = null;
  let _odataModel = null;
  let _i18nBundle = null;

  // ---------------------------------------------------------------------------
  // i18n — local ResourceModel, no view required.
  // ---------------------------------------------------------------------------

  function _getBundle() {
    if (!_i18nBundle) {
      const rm = new ResourceModel({
        bundleName: "sap.tutorials.admin.kgCommunities.i18n.i18n"
      });
      _i18nBundle = rm.getResourceBundle();
    }
    return _i18nBundle;
  }

  // ---------------------------------------------------------------------------
  // Context resolution
  // ---------------------------------------------------------------------------

  // Resolve a binding context from any FE V4 press-arg shape:
  //   - array of contexts (LR multi-select toolbar): first element.
  //   - single Context object (OP page context passed directly).
  //   - UI5 Event (OP header button): getSource().getBindingContext().
  function _resolveCtx(arg) {
    if (!arg) return null;
    if (Array.isArray(arg)) return arg[0] || null;
    if (typeof arg.getModel === "function") return arg;    // already a Context
    if (typeof arg.getSource === "function") {
      const src = arg.getSource();
      if (src && typeof src.getBindingContext === "function") {
        return src.getBindingContext();
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Dialog
  // ---------------------------------------------------------------------------

  function _openParamDialog(communityId) {
    // Fresh viewState per open so the fragment's {viewState>/...} bindings never
    // carry stale values across LR→OP→LR sequences.
    const viewState = new JSONModel({
      communityId: communityId,
      missionSlug: "",
      title: "",
      busy: false
    });

    // Recreate the dialog on every open (approach a — destroy and rebuild).
    // The standalone dialog owns its own models, so there is no view to keep it
    // in sync with; recreating guarantees the {viewState>/...} and {i18n>...}
    // bindings resolve against the models we set below.
    if (_dialog) {
      if (!_dialog.bIsDestroyed) {
        _dialog.destroy();
      }
      _dialog = null;
    }

    Fragment.load({
      // No `id` — the fragment is not scoped to any view.
      name: "sap.tutorials.admin.kgCommunities.ext.PromoteDialog",
      controller: handlers
    }).then(function (dlg) {
      _dialog = dlg;
      // Standalone host: set every model the fragment binds against directly on
      // the dialog. It is NOT added as a dependent of any view.
      dlg.setModel(viewState, "viewState");
      dlg.setModel(new ResourceModel({
        bundleName: "sap.tutorials.admin.kgCommunities.i18n.i18n"
      }), "i18n");
      if (_odataModel) {
        dlg.setModel(_odataModel);   // default (OData) model for the bound action
      }
      dlg.open();
    });
  }

  // ---------------------------------------------------------------------------
  // Handlers object — also the Fragment's controller.
  // ---------------------------------------------------------------------------

  const handlers = {

    onPromoteToMission: function (arg) {
      const ctx = _resolveCtx(arg);
      const bundle = _getBundle();

      if (!ctx || ctx.getProperty("communityId") == null) {
        const msg = bundle
          ? bundle.getText("noCommunitySelected")
          : "No community selected. Please select a community row first.";
        MessageBox.error(msg);
        return;
      }

      // Capture the OData model from the row context — this is how the
      // view-agnostic handler reaches the service without a view.
      _odataModel = ctx.getModel();

      const communityId = ctx.getProperty("communityId");
      const coverageHigh = ctx.getProperty("coverageHigh");

      if (coverageHigh) {
        const pct = ctx.getProperty("missionCoveragePct") != null
          ? ctx.getProperty("missionCoveragePct") : "?";
        const dominantMission = ctx.getProperty("dominantMissionTitle") || "an existing mission";

        const msg = bundle
          ? bundle.getText("promoteHighCoverageWarning", [pct, dominantMission])
          : "~" + pct + "% of this community's tutorials are already in \"" + dominantMission +
            "\". Consider extending that mission instead.";

        const title = bundle
          ? bundle.getText("promoteHighCoverageTitle")
          : "High mission overlap";

        // Capture the "Promote anyway" label ONCE so the action-text and the
        // onClose comparison are always identical (avoids i18n jitter).
        const promoteAnyway = bundle ? bundle.getText("promoteAnyway") : "Promote anyway";

        MessageBox.warning(msg, {
          title: title,
          actions: [promoteAnyway, MessageBox.Action.CANCEL],
          emphasizedAction: MessageBox.Action.CANCEL,
          onClose: function (choice) {
            if (choice === promoteAnyway) {
              _openParamDialog(communityId);
            }
          }
        });
      } else {
        _openParamDialog(communityId);
      }
    },

    onPromoteConfirm: function () {
      if (!_dialog || _dialog.bIsDestroyed) return;

      const model = _dialog.getModel("viewState");
      const bundle = _getBundle();
      const communityId = model.getProperty("/communityId");
      const slug = (model.getProperty("/missionSlug") || "").trim();
      const title = (model.getProperty("/title") || "").trim();

      if (!slug || !title) {
        const msg = bundle ? bundle.getText("slugTitleRequired") : "Mission slug and title are required.";
        MessageBox.warning(msg);
        return;
      }

      if (!_odataModel) {
        MessageBox.error("No service model available. Please reload and try again.");
        return;
      }

      model.setProperty("/busy", true);

      const op = _odataModel.bindContext("/promoteCommunityToMission(...)");
      op.setParameter("communityId", communityId);
      op.setParameter("missionSlug", slug);
      op.setParameter("title", title);

      op.execute().then(function () {
        model.setProperty("/busy", false);
        if (_dialog && !_dialog.bIsDestroyed) _dialog.close();

        // Single toast: if the created Mission ID is available use the hint
        // message; otherwise show the plain success message. Two back-to-back
        // MessageToast.show() calls are singleton-replaced, so we build one.
        let toastMsg = bundle ? bundle.getText("promoteSuccess") : "Draft mission created.";
        try {
          const created = op.getBoundContext().getObject();
          if (created && created.ID) {
            toastMsg = bundle
              ? bundle.getText("promoteNavigateHint", [created.ID])
              : "Draft mission created (ID: " + created.ID + ").";
          }
        } catch (e) {
          // No navigation context available; use plain success message.
        }
        MessageToast.show(toastMsg);

        // Refresh the LR binding so the just-promoted community drops out of the
        // "not yet promoted" filter. Without a view we refresh the OData model
        // (best-effort — mirrors the view-free `concepts` sibling).
        try {
          if (_odataModel && _odataModel.refresh) _odataModel.refresh();
        } catch (e) {
          // Non-fatal; refresh is best-effort.
        }

      }).catch(function (err) {
        model.setProperty("/busy", false);
        const detail = (err && err.error && err.error.message)
          || (err && err.message) || String(err);
        MessageBox.error(detail);
      });
    },

    onPromoteCancel: function () {
      if (_dialog && !_dialog.bIsDestroyed) _dialog.close();
    }

  };

  return handlers;
});
