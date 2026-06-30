sap.ui.define([
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (MessageBox, MessageToast) {
  "use strict";

  // Estimated cost per generation call in cents. PR 3a observed ~$0.005 per
  // verb explainer (small prompts + small responses). Update if costs shift.
  const EST_COST_PER_ROW_CENTS = 0.5;

  function fmtUsd(cents) {
    const dollars = Math.floor(cents / 100);
    const remainder = cents % 100;
    return `$${dollars}.${remainder.toString().padStart(2, '0')}`;
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
    const res = await fetch('/admin/ShelfDefinitions?$filter=authoringStatus%20eq%20%27BLANK%27&$count=true&$top=0', {
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
                const result = await postAdminAction("generateShelfExplainers", { ids: [], mode: "fill-blanks" });
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
      const selectedContexts = oEvent.getParameter?.("selectedContexts") ?? [];
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
            const result = await postAdminAction("generateShelfExplainers", { ids, mode: "regenerate-selected" });
            MessageToast.show(`Regenerated ${result.processed}. Cost: ${result.cost}.`);
            await refreshContext(oEvent);
          } catch (e) {
            MessageBox.error(`Regenerate failed: ${e.message}`);
          }
        }
      });
    },

    onMarkReviewedSelected: async function (oEvent) {
      const selectedContexts = oEvent.getParameter?.("selectedContexts") ?? [];
      const ids = selectedContexts.map(c => c.getObject().ID);
      if (ids.length === 0) {
        MessageToast.show("Select one or more rows first.");
        return;
      }
      try {
        const result = await postAdminAction("bulkMarkShelfExplainerReviewed", { ids });
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
            const result = await postAdminAction("generateShelfExplainers", { ids: [row.ID], mode: "regenerate-selected" });
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
        // Calls the dedicated markShelfExplainerReviewed action (added in
        // Task 7). Plain OData PATCH would be rejected because
        // authoringStatus is @Common.FieldControl: #ReadOnly (Task 1).
        await postAdminAction("markShelfExplainerReviewed", { id: row.ID });
        MessageToast.show("Marked as reviewed.");
        await refreshContext(oEvent);
      } catch (e) {
        MessageBox.error(`Mark-reviewed failed: ${e.message}`);
      }
    }
  };
});
