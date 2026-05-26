sap.ui.define([], function () {
  "use strict";

  // FE V4 custom sections instantiate fragments without a wrapping
  // controller, so a `Controller.extend(...)` module gets loaded but its
  // methods are never reachable from `drop="..."` in the fragment. Use the
  // plain-handler + `core:require` pattern instead so the drop event
  // resolves against this module.
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
    }
  };
});
