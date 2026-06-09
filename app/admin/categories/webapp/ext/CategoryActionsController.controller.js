sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (ControllerExtension, MessageToast, MessageBox) {
  "use strict";

  function reportClassifyResult(result) {
    const r = result?.value || result || {};
    MessageToast.show(
      "Processed " + (r.processed ?? 0) + ": " +
      (r.succeeded ?? 0) + " ok, " +
      (r.failed ?? 0) + " failed, " +
      (r.skipped ?? 0) + " skipped"
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

  return ControllerExtension.extend("sap.tutorials.admin.categories.ext.CategoryActionsController", {

    override: {
      onInit: function () {}
    },

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
        const r = result?.value || result || {};
        MessageToast.show("Embedded " + (r.processed ?? 0) + " category seeds");
      } catch (e) {
        MessageBox.error("Embed failed: " + e.message);
      }
    }

  });
});
