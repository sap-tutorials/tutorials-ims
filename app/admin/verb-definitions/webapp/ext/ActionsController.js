sap.ui.define([
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/ui/core/Element"
], function (MessageBox, MessageToast, Element) {
  "use strict";

  // Estimated cost per generation call in cents. PR 3a observed ~$0.005 per
  // verb explainer (small prompts + small responses). Update if costs shift.
  const EST_COST_PER_ROW_CENTS = 0.5;

  // The OData entity path this app's List Report table binds to. Used to
  // identify the correct sap.ui.mdc.Table in the Element registry when FE V4
  // hands the handler no selection (see readSelectedContexts).
  const LR_ENTITY_PATH = "/VerbDefinitions";

  function fmtUsd(cents) {
    const dollars = Math.floor(cents / 100);
    const remainder = cents % 100;
    return `$${dollars}.${remainder.toString().padStart(2, '0')}`;
  }

  // FE V4 (UI5 ≥ 1.108) does NOT populate `oEvent.getParameter("selectedContexts")`
  // for custom manifest LineItem actions, and inside the admin-shell
  // componentUsage host (where these explainer apps run) it invokes the
  // `press` handler with NO ARGUMENT AT ALL — verified live against DEV UI5
  // 1.136 on 2026-08-08: `arg === undefined` even with rows selected and the
  // `requiresSelection`-gated button correctly enabled. The earlier reader
  // (which returned [] for a falsy arg) therefore ALWAYS toast-showed "Select
  // one or more rows first" and the POST never left the browser, so AI_SEEDED
  // rows never flipped — the exact bug this file has now been "fixed" for
  // twice. The load-bearing recovery is `_selectedFromTable()`: when the arg
  // yields nothing, read the selection straight off this app's
  // sap.ui.mdc.Table via the Element registry.
  function _selectedFromTable() {
    // Find THIS app's List Report MDC table by its bound entity path. Only one
    // mdc.Table is mounted per active admin-shell componentUsage, but keying on
    // the row-binding path keeps this correct if that ever changes. Returns the
    // selected V4 contexts (each exposes getObject()), or [] on any failure —
    // fail-quiet so a registry/table-shape change never re-crashes the handler.
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
    } catch (e) { /* registry unavailable → [] */ }
    return ctxs;
  }

  function readSelectedContexts(oEvent) {
    // FE V4 invokes manifest LineItem actions with DIFFERENT arg shapes
    // depending on template + host (standalone app vs admin-shell
    // componentUsage — these explainer apps run as the latter):
    //   - array of selected contexts (LR multi-select toolbar in some builds)
    //   - a UI5 Event (legacy / direct wiring) → getSource().getSelectedContexts()
    //   - undefined / null (admin-shell — the OBSERVED case on DEV 1.136)
    // Guarding `oEvent` itself is load-bearing: `oEvent.getSource?.()`
    // optional-chains the CALL, not the property read, so a bare undefined
    // arg threw "Cannot read properties of undefined (reading 'getSource')".
    // When NONE of the arg-borne shapes yield rows, fall back to reading the
    // selection off the app's mdc.Table (the admin-shell reality).
    if (Array.isArray(oEvent) && oEvent.length > 0) return oEvent;
    const src = oEvent && oEvent.getSource ? oEvent.getSource() : null;
    if (src && typeof src.getSelectedContexts === "function") {
      const ctxs = src.getSelectedContexts();
      if (Array.isArray(ctxs) && ctxs.length > 0) return ctxs;
    }
    const fromParam =
      (oEvent && oEvent.getParameter && oEvent.getParameter("contexts")) ??
      (oEvent && oEvent.getParameter && oEvent.getParameter("selectedContexts"));
    if (Array.isArray(fromParam) && fromParam.length > 0) return fromParam;
    // Admin-shell: the arg carried no selection — recover it from the table.
    return _selectedFromTable();
  }

  async function postAdminAction(actionName, payload) {
    // CAP OData V4 + XSUAA approuter requires CSRF token on action invocations.
    // Same pattern as app/admin/categories/webapp/ext/CategoryActionsController.js.
    const csrfResp = await fetch('/admin/', { headers: { 'x-csrf-token': 'fetch' } });
    const csrf = csrfResp.headers.get('x-csrf-token');
    const res = await fetch(`/admin/${actionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrf || 'fetch'
      },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${actionName} failed (HTTP ${res.status}): ${errText}`);
    }
    return res.json();
  }

  async function countBlankRows() {
    const res = await fetch('/admin/VerbDefinitions?$filter=authoringStatus%20eq%20%27BLANK%27&$count=true&$top=0', {
      credentials: 'include',
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return data['@odata.count'] ?? 0;
  }

  async function refreshContext(oEvent) {
    // After a successful action, ask FE to re-bind so the new
    // authoringStatus / tagline values surface.
    // Heavy-handed but reliable: FE V4's extensionAPI.refresh() varies
    // per template; reload is the safest cross-context option.
    window.location.reload();
  }

  return {
    onGenerateForBlanks: async function (oEvent) {
      try {
        const n = await countBlankRows();
        if (n === 0) {
          MessageToast.show("No BLANK rows to fill.");
          return;
        }
        const estCents = Math.ceil(n * EST_COST_PER_ROW_CENTS);
        MessageBox.warning(
          `Generate AI explainers for ${n} blank row${n === 1 ? '' : 's'}? Estimated cost: ${fmtUsd(estCents)}. This will not overwrite AI-seeded or human-reviewed rows.`,
          {
            title: "Generate explainers — bulk fill blanks",
            actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
            emphasizedAction: MessageBox.Action.OK,
            onClose: async (action) => {
              if (action !== MessageBox.Action.OK) return;
              MessageToast.show("Generating…");
              try {
                const result = await postAdminAction("generateVerbExplainers", { ids: [], mode: "fill-blanks" });
                MessageToast.show(`Generated ${result.processed} explainer${result.processed === 1 ? '' : 's'}. Cost: ${result.cost}.`);
                await refreshContext(oEvent);
              } catch (e) {
                MessageBox.error(`Generation failed: ${e.message}`);
              }
            }
          }
        );
      } catch (e) {
        MessageBox.error(`Pre-check failed: ${e.message}`);
      }
    },

    onRegenerateSelected: async function (oEvent) {
      // Selected contexts come from the list report's selection model.
      const selectedContexts = readSelectedContexts(oEvent);
      const ids = selectedContexts.map(c => c.getObject().ID);
      if (ids.length === 0) {
        MessageToast.show("Select one or more rows first.");
        return;
      }
      // Check if any selected row is REVIEWED — destructive-confirm if so.
      const reviewedSelected = selectedContexts.some(c => c.getObject().authoringStatus === 'REVIEWED');
      const estCents = Math.ceil(ids.length * EST_COST_PER_ROW_CENTS);
      const msg = reviewedSelected
        ? `${ids.length} selected — some are REVIEWED. Regenerating will OVERWRITE them. Cost: ${fmtUsd(estCents)}. Continue?`
        : `Regenerate ${ids.length} selected row${ids.length === 1 ? '' : 's'} with AI? Cost: ${fmtUsd(estCents)}.`;
      MessageBox.warning(msg, {
        title: reviewedSelected ? "Regenerate — overwrites REVIEWED rows" : "Regenerate selected",
        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
        emphasizedAction: reviewedSelected ? MessageBox.Action.CANCEL : MessageBox.Action.OK,
        onClose: async (action) => {
          if (action !== MessageBox.Action.OK) return;
          MessageToast.show("Regenerating…");
          try {
            const result = await postAdminAction("generateVerbExplainers", { ids, mode: "regenerate-selected" });
            MessageToast.show(`Regenerated ${result.processed}. Cost: ${result.cost}.`);
            await refreshContext(oEvent);
          } catch (e) {
            MessageBox.error(`Regenerate failed: ${e.message}`);
          }
        }
      });
    },

    onMarkReviewedSelected: async function (oEvent) {
      const selectedContexts = readSelectedContexts(oEvent);
      const ids = selectedContexts.map(c => c.getObject().ID);
      if (ids.length === 0) {
        MessageToast.show("Select one or more rows first.");
        return;
      }
      try {
        const result = await postAdminAction("bulkMarkVerbExplainerReviewed", { ids });
        const msg = result.skipped > 0
          ? `Marked ${result.processed} reviewed (${result.skipped} skipped — already reviewed or still blank).`
          : `Marked ${result.processed} reviewed.`;
        MessageToast.show(msg);
        await refreshContext(oEvent);
      } catch (e) {
        MessageBox.error(`Mark-reviewed failed: ${e.message}`);
      }
    },

    onRegenerateOne: async function (oEvent) {
      // Object-page button — operates on the current row's context.
      const ctx = oEvent.getSource().getBindingContext();
      if (!ctx) {
        MessageToast.show("No row context — refresh and try again.");
        return;
      }
      const row = ctx.getObject();
      const isReviewed = row.authoringStatus === 'REVIEWED';
      const msg = isReviewed
        ? `This row is REVIEWED. Regenerating will OVERWRITE it. Cost: ${fmtUsd(Math.ceil(EST_COST_PER_ROW_CENTS))}. Continue?`
        : `Regenerate this row with AI? Cost: ${fmtUsd(Math.ceil(EST_COST_PER_ROW_CENTS))}.`;
      MessageBox.warning(msg, {
        title: isReviewed ? "Regenerate — overwrites REVIEWED" : "Regenerate",
        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
        emphasizedAction: isReviewed ? MessageBox.Action.CANCEL : MessageBox.Action.OK,
        onClose: async (action) => {
          if (action !== MessageBox.Action.OK) return;
          MessageToast.show("Regenerating…");
          try {
            const result = await postAdminAction("generateVerbExplainers", { ids: [row.ID], mode: "regenerate-selected" });
            MessageToast.show(`Regenerated. Cost: ${result.cost}.`);
            await refreshContext(oEvent);
          } catch (e) {
            MessageBox.error(`Regenerate failed: ${e.message}`);
          }
        }
      });
    },

    onMarkReviewed: async function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext();
      if (!ctx) return;
      const row = ctx.getObject();
      try {
        // Calls the dedicated markVerbExplainerReviewed action (added in
        // Task 7). Plain OData PATCH would be rejected because
        // authoringStatus is @Common.FieldControl: #ReadOnly (Task 1).
        await postAdminAction("markVerbExplainerReviewed", { id: row.ID });
        MessageToast.show("Marked as reviewed.");
        await refreshContext(oEvent);
      } catch (e) {
        MessageBox.error(`Mark-reviewed failed: ${e.message}`);
      }
    }
  };
});
