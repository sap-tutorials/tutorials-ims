// app/admin/concepts/webapp/ext/ConceptActionsController.controller.js
//
// ControllerExtension that wires the page-level (List Report) and bound
// (Object Page) toolbar buttons to the unbound actions on
// KnowledgeGraphService (mounted at /graph/).
//
// Pattern mirrors app/admin/categories/webapp/ext/CategoryActionsController:
//   1. Fetch CSRF token via GET /graph/.
//   2. POST /graph/<actionName> with x-csrf-token header.
//
// All KnowledgeGraphService curation actions (mergeConcepts, vetoConcept,
// previewMerges, triggerGraphRebuild) are unbound — i.e. their OData URL is
// /graph/<actionName>, not /graph/Concepts(...)/<actionName>. The Object
// Page invocations therefore read the bound row's ID from the binding
// context and pass it as a request-body parameter.
sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (ControllerExtension, MessageToast, MessageBox) {
  "use strict";

  async function postAction(path, body) {
    const csrfResp = await fetch("/graph/", { headers: { "x-csrf-token": "fetch" } });
    const csrf = csrfResp.headers.get("x-csrf-token");
    const res = await fetch("/graph/" + path, {
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
    // 204 No Content is valid for void actions.
    if (res.status === 204) return null;
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  }

  return ControllerExtension.extend("sap.tutorials.admin.concepts.ext.ConceptActionsController", {

    override: {
      onInit: function () {}
    },

    // ---- List Report toolbar actions -------------------------------------

    onPreviewMerges: async function () {
      const oBundle = this.getView().getModel("i18n") &&
        this.getView().getModel("i18n").getResourceBundle();
      const t = (key, fallback) => (oBundle && oBundle.getText(key)) || fallback;

      try {
        const ticket = await postAction("previewMerges", {});
        const runId = ticket && ticket.runId;
        if (!runId) {
          MessageBox.error("Preview failed: no run id returned.");
          return;
        }
        MessageToast.show(t("previewComputingToast", "Computing merge candidates…"));

        const row = await this._pollPreviewRun(runId, 2000, 180000);
        if (!row) {
          MessageBox.warning(t("previewTimeoutMessage",
            "Merge preview is still running. Please try again in a minute."));
          return;
        }
        if (row.status === "FAILED") {
          MessageBox.error("Preview failed: " + (row.lastError || "unknown error"));
          return;
        }
        // DONE
        const pairs = row.resultJson ? JSON.parse(row.resultJson) : [];
        const total = (typeof row.candidatePairs === "number") ? row.candidatePairs : pairs.length;
        if (pairs.length === 0) {
          MessageToast.show(t("previewNoCandidates", "No merge candidates at the current threshold."));
          return;
        }
        const lines = pairs.slice(0, 50).map(function (p) {
          const sim = (Number(p.similarity) * 100).toFixed(1);
          return p.loserSlug + " → " + p.canonicalSlug + " (" + sim + "%)";
        });
        const moreSuffix = total > 50 ? "\n... and " + (total - 50) + " more" : "";
        MessageBox.information(lines.join("\n") + moreSuffix, {
          title: total + " merge candidate(s)"
        });
      } catch (err) {
        MessageBox.error("Preview failed: " + (err && err.message ? err.message : String(err)));
      }
    },

    /**
     * Poll GET /graph/ConceptMergePreviewRuns(<runId>) every `intervalMs` until
     * status leaves RUNNING or `ceilingMs` elapses. Returns the row (DONE/FAILED)
     * or null on ceiling. Mirrors the bounded setInterval poll in the admin-shell
     * Board dashboard (job-controls refresh).
     */
    _pollPreviewRun: function (runId, intervalMs, ceilingMs) {
      const deadline = Date.now() + ceilingMs;
      const url = "/graph/ConceptMergePreviewRuns(" + runId + ")";
      return new Promise(function (resolve) {
        (function tick() {
          fetch(url, { headers: { "Accept": "application/json" } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (row) {
              if (row && row.status && row.status !== "RUNNING") {
                resolve(row);
                return;
              }
              if (Date.now() >= deadline) {
                resolve(null);
                return;
              }
              setTimeout(tick, intervalMs);
            })
            .catch(function () {
              if (Date.now() >= deadline) { resolve(null); return; }
              setTimeout(tick, intervalMs);
            });
        })();
      });
    },

    onTriggerGraphRebuild: async function () {
      try {
        const result = await postAction("triggerGraphRebuild", {});
        const triples = (result && result.tripleCount) || 0;
        const ms = (result && result.durationMs) || 0;
        const v = (result && result.graphVersion) || "(unknown)";
        MessageToast.show("Rebuilt: " + triples + " triples in " + ms + " ms (graphVersion " + v + ")");
      } catch (err) {
        MessageBox.error("Rebuild failed: " + (err && err.message ? err.message : String(err)));
      }
    },

    // ---- Object Page bound actions ---------------------------------------
    //
    // The OP context binds to /Concepts(<UUID>); reading the row's ID is the
    // straightforward way to wire an unbound CDS action to a bound-looking
    // toolbar button. Confirmation prompts are used because both actions are
    // destructive (vetoConcept flips status; mergeConcepts collapses two rows).

    onVetoConcept: function (oEvent) {
      const oContext = this._readContext(oEvent);
      if (!oContext) return;
      const data = oContext.getObject();
      const conceptId = data && data.ID;
      const conceptSlug = (data && data.slug) || conceptId;
      if (!conceptId) {
        MessageBox.error("Could not determine concept ID from selection.");
        return;
      }
      MessageBox.confirm(
        "Veto concept '" + conceptSlug + "'? This flags it as VETOED and removes it from the public knowledge graph.",
        {
          title: "Confirm veto",
          onClose: async function (action) {
            if (action !== MessageBox.Action.OK) return;
            try {
              await postAction("vetoConcept", { conceptId: conceptId });
              MessageToast.show("Concept '" + conceptSlug + "' vetoed.");
              // Refresh the list so the status flip is visible.
              const oModel = oContext.getModel();
              if (oModel && oModel.refresh) oModel.refresh();
            } catch (err) {
              MessageBox.error("Veto failed: " + (err && err.message ? err.message : String(err)));
            }
          }
        }
      );
    },

    onMergeConcepts: function (oEvent) {
      const oContext = this._readContext(oEvent);
      if (!oContext) return;
      const data = oContext.getObject();
      const loserId = data && data.ID;
      const loserSlug = (data && data.slug) || loserId;
      if (!loserId) {
        MessageBox.error("Could not determine concept ID from selection.");
        return;
      }
      // Plain text-input prompt for the canonical UUID. A proper
      // value-help dialog over ACTIVE Concepts is the next-iteration polish
      // (admin can Cmd+click into the list, copy the ID column, paste here).
      // Keeping this minimal in PR 6 part 1 keeps the action wiring simple.
      MessageBox.show(
        "Paste the canonical Concept UUID for '" + loserSlug + "'. The losing concept's tutorial links and edges are redirected, then it is flagged MERGED.",
        {
          icon: MessageBox.Icon.QUESTION,
          title: "Merge into canonical",
          actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
          input: { placeholder: "00000000-0000-0000-0000-000000000000" },
          onClose: async function (action, sValue) {
            if (action !== MessageBox.Action.OK) return;
            const canonicalId = (sValue || "").trim();
            if (!canonicalId) {
              MessageBox.error("Canonical UUID is required.");
              return;
            }
            if (canonicalId === loserId) {
              MessageBox.error("Loser and canonical must differ.");
              return;
            }
            try {
              await postAction("mergeConcepts", {
                loser: loserId,
                canonical: canonicalId
              });
              MessageToast.show("Concept '" + loserSlug + "' merged.");
              const oModel = oContext.getModel();
              if (oModel && oModel.refresh) oModel.refresh();
            } catch (err) {
              MessageBox.error("Merge failed: " + (err && err.message ? err.message : String(err)));
            }
          }
        }
      );
    },

    // ---- Helpers ---------------------------------------------------------

    /**
     * Read the binding context for an Object Page action. Fiori Elements
     * passes the bound context via the event source's binding. We fall back
     * to `this.getView().getBindingContext()` for older controller-extension
     * shapes.
     */
    _readContext: function (oEvent) {
      try {
        const oSource = oEvent && oEvent.getSource && oEvent.getSource();
        const oBindingCtx = (oSource && oSource.getBindingContext && oSource.getBindingContext())
          || (this.getView && this.getView().getBindingContext && this.getView().getBindingContext());
        return oBindingCtx || null;
      } catch (e) {
        return null;
      }
    }

  });
});
