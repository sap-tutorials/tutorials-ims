sap.ui.define([
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/ui/core/ElementRegistry",
  "sap/ui/core/routing/HashChanger"
], function (MessageBox, MessageToast, ElementRegistry, HashChanger) {
  "use strict";

  // The OData entity path this app's List Report table binds to. Used to
  // recover the selection off the sap.ui.mdc.Table when FE V4 hands the press
  // handler no argument inside the admin-shell componentUsage host. See the
  // long-form rationale in shelf-definitions/ext/ActionsController.js.
  const LR_ENTITY_PATH = "/Missions";

  function _selectedFromTable() {
    // Find THIS app's List Report MDC table by its bound entity path and read
    // the selected V4 contexts (each exposes getObject()). Fail-quiet → [].
    let ctxs = [];
    try {
      ElementRegistry.forEach(function (el) {
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
    // FE V4 invokes manifest LineItem actions with different arg shapes per
    // template + host; inside the admin-shell componentUsage the arg is often
    // undefined. Try each borne shape, then recover from the mdc.Table.
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
    return _selectedFromTable();
  }

  async function postAdminAction(actionName, payload) {
    // CAP OData V4 + XSUAA approuter requires a CSRF token on action POSTs.
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

  function navigateToCopy(newId) {
    // Deep-link into this missions componentUsage's inner Object Page route
    // (pattern "Missions({key})"). The shell owns the top-level hash as
    // "<outerRouteKey>&/<innerRoute>"; the missions outer route key is
    // "missions" and we are already under it (the action fires from the
    // missions List Report), so driving the hash to the OP navigates in place.
    // Mirrors the documented deep-link pattern in Shell.controller.js
    // (petoberfestContests / homepageConfig). Missions is draft-enabled, so the
    // active-instance key carries IsActiveEntity=true; the copy opens in display
    // mode — press Edit to make further changes.
    const key = `ID=${newId},IsActiveEntity=true`;
    HashChanger.getInstance().setHash(`missions&/Missions(${key})`);
  }

  return {
    onCopyMission: async function (oEvent) {
      const selectedContexts = readSelectedContexts(oEvent);
      const ids = selectedContexts.map(c => c.getObject().ID);
      if (ids.length === 0) {
        MessageToast.show("Select a mission to copy first.");
        return;
      }
      if (ids.length > 1) {
        MessageToast.show("Select exactly one mission to copy.");
        return;
      }
      MessageToast.show("Copying mission…");
      try {
        const copy = await postAdminAction("copyMission", { ID: ids[0] });
        MessageToast.show(`Created copy: ${copy.title}`);
        navigateToCopy(copy.ID);
      } catch (e) {
        MessageBox.error(`Copy failed: ${e.message}`);
      }
    }
  };
});
