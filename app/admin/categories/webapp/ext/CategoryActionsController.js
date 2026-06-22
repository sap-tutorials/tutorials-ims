// app/admin/categories/webapp/ext/CategoryActionsController.js
//
// Plain UI5 module for the Categories List Report toolbar actions
// (`classifyUncategorized`, `reclassifyAll`, `embedSeeds`).
//
// Why NOT a ControllerExtension: Fiori Elements v4 resolves `press`
// references in manifest action config as plain modules (loader path
// `<dotted-name>.js`), not as controller extensions (loader path
// `<dotted-name>.controller.js`). The original implementation lived
// in `CategoryActionsController.controller.js` and produced 404s on
// every click of the toolbar action (latent — buttons rarely clicked).
// Mirrors the ConceptActionsController.js fix shipped in PR #537 and
// the AdvocatePhotoController.js fix in PR #405.
//
// Issue: #538. Memory: feedback_ui5_controller_suffix_collision.
sap.ui.define([
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (MessageToast, MessageBox) {
  "use strict";

  function reportClassifyResult(result) {
    const r = (result && result.value) || result || {};
    MessageToast.show(
      "Processed " + (r.processed != null ? r.processed : 0) + ": " +
      (r.succeeded != null ? r.succeeded : 0) + " ok, " +
      (r.failed != null ? r.failed : 0) + " failed, " +
      (r.skipped != null ? r.skipped : 0) + " skipped"
    );
  }

  async function postAction(path, body) {
    const csrfResp = await fetch("/admin/", { headers: { "x-csrf-token": "fetch" } });
    const csrf = csrfResp.headers.get("x-csrf-token");
    const res = await fetch("/admin/" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrf || "fetch"
      },
      body: JSON.stringify(body || {})
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(res.status + " " + txt);
    }
    return res.json();
  }

  return {

    onClassifyUncategorized: async function () {
      try {
        MessageToast.show("Classifying uncategorized items…");
        const result = await postAction("classifyCategories", { kind: "all", ids: [], force: false });
        reportClassifyResult(result);
      } catch (e) {
        MessageBox.error("Classify failed: " + e.message);
      }
    },

    onReclassifyAll: function () {
      MessageBox.warning(
        "This will overwrite EVERY category assignment, including any you have manually edited. There is no undo. Continue?",
        {
          icon: MessageBox.Icon.WARNING,
          title: "Re-classify everything (destructive)",
          actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
          emphasizedAction: MessageBox.Action.CANCEL,
          onClose: async function (action) {
            if (action !== MessageBox.Action.OK) return;
            try {
              MessageToast.show("Reclassifying — this may take a while…");
              const result = await postAction("classifyCategories", { kind: "all", ids: [], force: true });
              reportClassifyResult(result);
            } catch (e) {
              MessageBox.error("Reclassify failed: " + e.message);
            }
          }
        }
      );
    },

    onEmbedSeeds: async function () {
      try {
        MessageToast.show("Re-embedding category seeds…");
        const result = await postAction("embedAllSeeds", {});
        const r = (result && result.value) || result || {};
        MessageToast.show("Embedded " + (r.processed != null ? r.processed : 0) + " category seeds");
      } catch (e) {
        MessageBox.error("Embed failed: " + e.message);
      }
    }

  };
});
