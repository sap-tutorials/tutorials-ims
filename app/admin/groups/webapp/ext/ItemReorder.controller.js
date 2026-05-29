sap.ui.define([], function () {
  "use strict";

  // FE V4 custom sections instantiate fragments without a wrapping
  // controller, so a `Controller.extend(...)` module gets loaded but its
  // methods are never reachable from `drop="..."` in the fragment. Use the
  // plain-handler + `core:require` pattern instead so the drop event
  // resolves against this module.
  //
  // Drag is gated by `enabled="{= !%{IsActiveEntity} }"` on DragDropInfo
  // (note `%{...}` — context-property syntax that walks up to the parent OP
  // context. `${...}` would resolve against the row binding, where
  // IsActiveEntity does not exist; that resolves to undefined, making the
  // expression `!undefined === true` so drag was allowed in active mode too,
  // which fed the "snap back" symptom: setProperty on read-only active rows
  // silently no-ops).
  return {
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

      // Defensive: setProperty on a read-only (active) entity silently
      // resolves without writing, which would leave us in the previous
      // "drop fires but rows snap back" state. Refuse the drop unless the
      // dragged context is in draft mode. The fragment's `enabled` binding
      // already gates this, but we double-check here so a subtle binding
      // regression surfaces with a console message instead of a silent fail.
      if (oDraggedContext.getProperty("IsActiveEntity") !== false) {
        // eslint-disable-next-line no-console
        console.warn("ItemReorder: drop fired against an active entity — ignoring (parent OP must be in draft/edit mode)");
        return;
      }

      var aNewOrder = aContexts.filter(function (_, i) { return i !== iDragIndex; });
      aNewOrder.splice(iDropIndex, 0, oDraggedContext);

      // Context#setProperty returns a Promise that resolves when the PATCH
      // against the draft completes. Await ALL of them before refreshing —
      // V4 ODataListBinding#refresh() throws if any pending changes exist,
      // and we need the server-side draft to hold the new itemOrder values
      // before the re-fetch so $orderby returns the rows in the right order.
      try {
        await Promise.all(aNewOrder.map(function (ctx, idx) {
          return ctx.setProperty("itemOrder", (idx + 1) * 10);
        }));
      } catch (oErr) {
        // eslint-disable-next-line no-console
        console.error("ItemReorder: setProperty(itemOrder) failed — reorder NOT persisted", oErr);
        return;
      }

      // Force a re-fetch of the items aggregation so the existing
      // sorter:{path:'itemOrder'} on the binding applies against the just-
      // PATCHed values. We can't use oBinding.sort([new Sorter("itemOrder")])
      // here: V4 treats same-path sorters as unchanged (since 1.97.0) and
      // the call becomes a silent no-op, leaving the cached row order
      // intact — that's the "rows snap back" symptom from issue #70.
      try {
        oBinding.refresh();
      } catch (oErr) {
        // eslint-disable-next-line no-console
        console.error("ItemReorder: oBinding.refresh() failed after reorder", oErr);
      }
    }
  };
});
