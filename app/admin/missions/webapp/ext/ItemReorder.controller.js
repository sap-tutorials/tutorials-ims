sap.ui.define([], function () {
  "use strict";

  // FE V4 custom sections instantiate fragments without a wrapping
  // controller, so a `Controller.extend(...)` module gets loaded but its
  // methods are never reachable from `drop="..."` in the fragment. Use the
  // same plain-handler + `core:require` pattern as TaskColumnHandler.js so
  // the drop event resolves against this module.
  //
  // Drag is gated by `enabled="{= !${IsActiveEntity} }"` on DragDropInfo
  // so this handler only fires in draft mode — setProperty would silently
  // reject on an active (non-draft) entity in a draft-enabled service.
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

      var aNewOrder = aContexts.filter(function (_, i) { return i !== iDragIndex; });
      aNewOrder.splice(iDropIndex, 0, oDraggedContext);

      // Context#setProperty returns a Promise that resolves when the PATCH
      // against the draft completes. Await ALL of them before refreshing —
      // V4 ODataListBinding#refresh() throws if any pending changes exist,
      // and we need the server-side draft to hold the new itemOrder values
      // before the re-fetch so $orderby returns the rows in the right order.
      await Promise.all(aNewOrder.map(function (ctx, idx) {
        return ctx.setProperty("itemOrder", (idx + 1) * 10);
      }));

      // Force a re-fetch of the items aggregation so the existing
      // sorter:{path:'itemOrder'} on the binding applies against the just-
      // PATCHed values. We can't use oBinding.sort([new Sorter("itemOrder")])
      // here: V4 treats same-path sorters as unchanged (since 1.97.0) and
      // the call becomes a silent no-op, leaving the cached row order
      // intact — that's the "rows snap back" symptom from issue #70.
      oBinding.refresh();
    }
  };
});
