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
// (PromoteDialog.fragment.xml) is loaded with `controller: handlers` so its
// button press bindings resolve to the handlers below.
//
// View resolution: FE V4 press handlers pass either a UI5 Event (OP header
// button) or an array of selected contexts (LR toolbar). Both forms are handled
// by _resolveView(); the LR singleton byId fallback is last-resort.
//
// Context resolution: _resolveCtx() mirrors the same multi-shape logic to
// read communityId / coverageHigh / missionCoveragePct / dominantMissionTitle
// from the selected row (LR) or current page context (OP).
//
// Action invocation: bindContext("/promoteCommunityToMission(...)")
// instead of editFlow.invokeAction — the plain module has no this.base.
sap.ui.define([
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Fragment, JSONModel, MessageBox, MessageToast) {
  "use strict";

  // Module-level state.
  // _dialog: tracked only to destroy the previous instance before recreating per
  // open. NOT reused across views — see _openParamDialog for rationale.
  let _dialog = null;
  let _resolvedView = null;

  // ---------------------------------------------------------------------------
  // View resolution
  // ---------------------------------------------------------------------------

  // Resolve the active view from any press-arg shape FE V4 might supply.
  // Shape 1 — UI5 Event (OP header action): walk getSource() up to View.
  // Shape 2 — array of contexts (LR toolbar): no direct view ref; fall through.
  // Shape 3 — byId fallback for the LR singleton (known FE V4 ID convention).
  function _resolveView(arg) {
    // Prefer a freshly-resolved candidate each call (OP and LR have different
    // view IDs; the cached _resolvedView may be stale after navigation).
    let candidate = null;

    // Shape 1: UI5 Event with getSource().
    if (arg && typeof arg.getSource === "function") {
      candidate = arg.getSource();
      while (candidate && !candidate.isA("sap.ui.core.mvc.View")) {
        candidate = candidate.getParent ? candidate.getParent() : null;
      }
      if (candidate) {
        _resolvedView = candidate;
        return _resolvedView;
      }
    }

    // Shape 2: array of binding contexts — try to get the view via the model's
    // owner (limited API; most likely falls through to byId).
    if (!candidate && Array.isArray(arg) && arg.length > 0) {
      // No reliable view-from-context API in UI5; skip to byId.
    }

    // Shape 3: byId fallback — LR singleton (FE V4 ID convention).
    if (!candidate) {
      const core = sap.ui.getCore();
      candidate = core.byId(
        "container-sap.tutorials.admin.kgCommunities---sap.fe.templates.ListReport.view.ListReport"
      );
    }

    _resolvedView = candidate || null;
    return _resolvedView;
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
  // Internal helpers
  // ---------------------------------------------------------------------------

  function _getBundle(view) {
    return view && view.getModel("i18n") && view.getModel("i18n").getResourceBundle();
  }

  function _openParamDialog(view, communityId) {
    // Set or reset the viewState model on the CURRENT view BEFORE loading the
    // fragment so initial bindings resolve against this view's model.
    let model = view.getModel("viewState");
    if (!model) {
      model = new JSONModel({ communityId: communityId, missionSlug: "", title: "", busy: false });
      view.setModel(model, "viewState");
    } else {
      model.setData({ communityId: communityId, missionSlug: "", title: "", busy: false });
    }

    // Always recreate the dialog against the current view (approach a — destroy
    // and rebuild on every open).
    //
    // Rationale: the dialog is addDependent on whichever view first opened it.
    // Its {viewState>/...} bindings resolve against THAT view's model. If the
    // user opens from LR, cancels, navigates to OP and opens again, the cached
    // dialog still references the LR view's viewState — inputs read/write the
    // wrong model and onPromoteConfirm reads an empty viewState despite visible
    // input. Additionally, UI5 may destroy the original dependent view on
    // navigation, leaving _dialog in a destroyed state that throws on .open().
    //
    // The dialog is lightweight (2 inputs), so per-open recreation is acceptable.
    if (_dialog) {
      if (!_dialog.bIsDestroyed) {
        _dialog.destroy();
      }
      _dialog = null;
    }

    Fragment.load({
      id: view.getId(),
      name: "sap.tutorials.admin.kgCommunities.ext.PromoteDialog",
      controller: handlers
    }).then(function (dlg) {
      _dialog = dlg;
      view.addDependent(dlg);
      dlg.open();
    });
  }

  // ---------------------------------------------------------------------------
  // Handlers object — also the Fragment's controller.
  // ---------------------------------------------------------------------------

  const handlers = {

    onPromoteToMission: function (arg) {
      const view = _resolveView(arg);
      if (!view) {
        // Bundle lookup requires a resolved view — chicken-and-egg here.
        // Keep this error hardcoded; it should never surface in normal usage.
        MessageBox.error("Could not resolve the view. Please reload and try again.");
        return;
      }

      const ctx = _resolveCtx(arg);
      if (!ctx || ctx.getProperty("communityId") == null) {
        const bundle = _getBundle(view);
        const msg = bundle
          ? bundle.getText("noCommunitySelected")
          : "No community selected. Please select a community row first.";
        MessageBox.error(msg);
        return;
      }

      const communityId = ctx.getProperty("communityId");
      const coverageHigh = ctx.getProperty("coverageHigh");
      const bundle = _getBundle(view);

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
              _openParamDialog(view, communityId);
            }
          }
        });
      } else {
        _openParamDialog(view, communityId);
      }
    },

    onPromoteConfirm: function () {
      const view = _resolvedView;
      if (!view) return;

      const model = view.getModel("viewState");
      const communityId = model.getProperty("/communityId");
      const slug = (model.getProperty("/missionSlug") || "").trim();
      const title = (model.getProperty("/title") || "").trim();
      const bundle = _getBundle(view);

      if (!slug || !title) {
        const msg = bundle ? bundle.getText("slugTitleRequired") : "Mission slug and title are required.";
        MessageBox.warning(msg);
        return;
      }

      model.setProperty("/busy", true);

      const odataModel = view.getModel();
      const op = odataModel.bindContext("/promoteCommunityToMission(...)");
      op.setParameter("communityId", communityId);
      op.setParameter("missionSlug", slug);
      op.setParameter("title", title);

      op.execute().then(function () {
        model.setProperty("/busy", false);
        if (_dialog) _dialog.close();

        // Single toast: if the created Mission ID is available use the hint
        // message (which already contains the success context); otherwise show
        // the plain success message. Two back-to-back MessageToast.show() calls
        // are singleton-replaced — the second overwrites the first, so the user
        // would never see the primary success text.
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

        // Refresh the LR binding if reachable.
        try {
          const lr = view.byId("fe::table::KgCommunities::LineItem-innerTable");
          if (lr && lr.getBinding("items")) {
            lr.getBinding("items").refresh();
          }
        } catch (e) {
          // Non-fatal; LR refresh is best-effort.
        }

      }).catch(function (err) {
        model.setProperty("/busy", false);
        const detail = (err && err.error && err.error.message)
          || (err && err.message) || String(err);
        MessageBox.error(detail);
      });
    },

    onPromoteCancel: function () {
      if (_dialog) _dialog.close();
    }

  };

  return handlers;
});
