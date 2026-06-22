// app/admin/concepts/webapp/ext/ConceptActionsController.js
//
// Plain UI5 module for the Concepts List Report + Object Page toolbar
// actions on KnowledgeGraphService.
//
// Why NOT a ControllerExtension: Fiori Elements v4 resolves `press`
// references in manifest action config as plain modules (loader path
// `<dotted-name>.js`), not as controller extensions (loader path
// `<dotted-name>.controller.js`). The original implementation lived
// in `ConceptActionsController.controller.js` and produced 404s on
// every click — observed live 2026-06-22 when triggering Graph
// Rebuild from /admin-ui/#/concepts. Mirrors the AdvocatePhotoController
// fix shipped in PR #405 / memory `feedback_ui5_controller_suffix_collision`.
//
// FE V4 manifest-action handler signature (single argument):
//   - For OP header actions: an array of length 1 — [<page context>]
//   - For List Report toolbar actions: an array of selected rows
//   - For some FE variants: a single Context (no array wrapper)
//   - Legacy / direct UI5 wiring: a UI5 Event (use getSource().getBindingContext())
// resolveCtx() handles all four shapes.
//
// All KnowledgeGraphService curation actions (mergeConcepts, vetoConcept,
// previewMerges, triggerGraphRebuild) are unbound — i.e. their OData URL
// is /graph/<actionName>, not /graph/Concepts(...)/<actionName>. The
// Object Page invocations therefore read the bound row's ID from the
// binding context and pass it as a request-body parameter.
sap.ui.define([
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (MessageToast, MessageBox) {
  "use strict";

  // Resolve the binding context regardless of how FE V4 invoked the handler.
  function resolveCtx(arg) {
    if (!arg) return null;
    if (Array.isArray(arg)) return arg[0] || null;
    if (typeof arg.getModel === "function") return arg;
    if (typeof arg.getSource === "function") {
      const src = arg.getSource();
      if (src && typeof src.getBindingContext === "function") {
        return src.getBindingContext();
      }
    }
    return null;
  }

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

  return {

    // ---- List Report toolbar actions -------------------------------------

    onPreviewMerges: async function () {
      try {
        const result = await postAction("previewMerges", {});
        const pairs = (result && result.value) || [];
        if (pairs.length === 0) {
          MessageToast.show("No merge candidates at the current threshold.");
          return;
        }
        const lines = pairs.slice(0, 50).map(function (p) {
          const sim = (Number(p.similarity) * 100).toFixed(1);
          return p.loserSlug + " → " + p.canonicalSlug + " (" + sim + "%)";
        });
        const moreSuffix = pairs.length > 50 ? "\n... and " + (pairs.length - 50) + " more" : "";
        MessageBox.information(lines.join("\n") + moreSuffix, {
          title: pairs.length + " merge candidate(s)"
        });
      } catch (err) {
        MessageBox.error("Preview failed: " + (err && err.message ? err.message : String(err)));
      }
    },

    onTriggerGraphRebuild: async function () {
      // The rebuild can take 30-60s+ on a cold graph (1089 concepts → ~3000
      // triples projected + inserted in batches). Show a toast immediately
      // so the admin knows the click registered, even though the final
      // success toast won't fire until the round-trip completes.
      MessageToast.show("Triggering graph rebuild — may take up to a minute…");
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

    onVetoConcept: function (arg) {
      const oContext = resolveCtx(arg);
      if (!oContext) {
        MessageBox.error("Could not resolve binding context for the selected concept.");
        return;
      }
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
              const oModel = oContext.getModel();
              if (oModel && oModel.refresh) oModel.refresh();
            } catch (err) {
              MessageBox.error("Veto failed: " + (err && err.message ? err.message : String(err)));
            }
          }
        }
      );
    },

    onMergeConcepts: function (arg) {
      const oContext = resolveCtx(arg);
      if (!oContext) {
        MessageBox.error("Could not resolve binding context for the selected concept.");
        return;
      }
      const data = oContext.getObject();
      const loserId = data && data.ID;
      const loserSlug = (data && data.slug) || loserId;
      if (!loserId) {
        MessageBox.error("Could not determine concept ID from selection.");
        return;
      }
      // Plain text-input prompt for the canonical UUID. A proper
      // value-help dialog over ACTIVE Concepts is the next-iteration polish.
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
    }

  };
});
