sap.ui.define(["sap/ui/model/Sorter"], function (Sorter) {
  "use strict";

  // FE V4 custom sections instantiate fragments without a wrapping
  // controller, so a `Controller.extend(...)` module gets loaded but its
  // methods are never reachable from `drop="..."` in the fragment. Use the
  // plain-handler + `core:require` pattern instead so the drop event
  // resolves against this module.
  //
  // Drag is gated by `enabled="{= !${IsActiveEntity} }"` on DragDropInfo
  // so this handler only fires in draft mode — setProperty would silently
  // reject on an active (non-draft) entity in a draft-enabled service.
  return {
    onDrop: function (oEvent) {
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

      aNewOrder.forEach(function (ctx, idx) {
        ctx.setProperty("itemOrder", (idx + 1) * 10);
      });

      // Re-apply the sorter so the table reflects the new itemOrder values.
      // V4 ListBinding does not auto-resort when individual context
      // properties change locally — the sorter only applies on bind/refresh
      // unless re-set explicitly. sort() preserves pending draft changes;
      // refresh() would discard them.
      oBinding.sort([new Sorter("itemOrder")]);
    }
  };
});
