sap.ui.define([], function () {
  "use strict";

  // See [app/admin/groups/webapp/ext/ItemReorderHandler.js] for the full
  // rationale — short version: FE V4 custom-section fragments don't propagate
  // `core:require` aliases into EventHandlerResolver's mLocals, so
  // `drop="handler.onDrop"` resolves to undefined and the drop is a silent
  // no-op (verified live in DEV against UI5 1.136.0 on 2026-05-29). Workaround:
  // publish this module to its sap-namespace path on globalThis and reference
  // it by fully-qualified path from the fragment's `drop=` attribute.
  //
  // Drag is gated by `enabled="{= !%{IsActiveEntity} }"` on DragDropInfo so
  // the handler only fires in draft mode (active rows would silently no-op
  // on setProperty in a draft-enabled service).
  var Handler = {
    onDrop: async function (oEvent) {
      var oDraggedItem = oEvent.getParameter("draggedControl");
      var oDroppedItem = oEvent.getParameter("droppedControl");
      var sDropPosition = oEvent.getParameter("dropPosition");

      var oTable = oDroppedItem.getParent();
      var aItems = oTable.getItems();
      var iDragIndex = aItems.indexOf(oDraggedItem);
      var iDropIndex = aItems.indexOf(oDroppedItem);

      if (sDropPosition === "After") { iDropIndex++; }
      if (iDragIndex < iDropIndex) { iDropIndex--; }

      var oBinding = oTable.getBinding("items");
      var aContexts = oBinding.getCurrentContexts();
      var oDraggedContext = aContexts[iDragIndex];

      // Defensive: setProperty on a read-only (active) entity silently resolves
      // without writing, which would leave us in the previous "drop fires but
      // rows snap back" state. Refuse the drop unless the dragged context is in
      // draft mode. The fragment's `enabled` binding already gates this, but we
      // double-check here so a binding regression surfaces with a console
      // message instead of a silent fail.
      if (oDraggedContext.getProperty("IsActiveEntity") !== false) {
        // eslint-disable-next-line no-console
        console.warn("ItemReorder: drop fired against an active entity — ignoring (parent OP must be in draft/edit mode)");
        return;
      }

      var aNewOrder = aContexts.filter(function (_, i) { return i !== iDragIndex; });
      aNewOrder.splice(iDropIndex, 0, oDraggedContext);

      try {
        await Promise.all(aNewOrder.map(function (ctx, idx) {
          return ctx.setProperty("itemOrder", (idx + 1) * 10);
        }));
      } catch (oErr) {
        // eslint-disable-next-line no-console
        console.error("ItemReorder: setProperty(itemOrder) failed — reorder NOT persisted", oErr);
        return;
      }

      // Force a re-fetch so the binding's sorter:{path:'itemOrder'} applies
      // against the just-PATCHed values. `sort([new Sorter("itemOrder")])` is
      // a silent no-op since UI5 1.97.0 (same path as existing sorter), which
      // is the original "rows snap back" symptom from issue #70.
      try {
        oBinding.refresh();
      } catch (oErr) {
        // eslint-disable-next-line no-console
        console.error("ItemReorder: oBinding.refresh() failed after reorder", oErr);
      }
    }
  };

  /* global globalThis */
  var g = (typeof globalThis !== "undefined" ? globalThis : window);
  g.sap = g.sap || {};
  g.sap.tutorials = g.sap.tutorials || {};
  g.sap.tutorials.admin = g.sap.tutorials.admin || {};
  g.sap.tutorials.admin.missions = g.sap.tutorials.admin.missions || {};
  g.sap.tutorials.admin.missions.ext = g.sap.tutorials.admin.missions.ext || {};
  g.sap.tutorials.admin.missions.ext.ItemReorderHandler = Handler;

  return Handler;
});
