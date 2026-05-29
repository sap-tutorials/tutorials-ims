sap.ui.define([], function () {
  "use strict";

  // FE V4 custom-section fragments are loaded WITHOUT a wrapping controller, so
  // the only way to wire an event handler in the fragment XML is to give the
  // attribute a name UI5's `EventHandlerResolver` can resolve in that controller-
  // less context.
  //
  // Resolution paths supported by `sap/ui/core/mvc/EventHandlerResolver` (v1.136):
  //   1. Leading dot ".onDrop"        -> controller-local method (no controller here -> N/A)
  //   2. "alias.method" + mLocals     -> `core:require` alias from XML scope
  //   3. "sap.foo.bar.Mod.method"     -> walks `globalThis.sap.foo.bar.Mod` then `.method`
  //   4. "cmd:CommandName"            -> sap.ui.core.CommandExecution shortcut
  //
  // Path #2 (`drop="handler.onDrop"` + `core:require="{ handler: '<id>' }"`) is
  // what every previous fix attempt assumed. Empirically — verified in DEV via
  // the live UI5 element registry on 2026-05-29 — `core:require` declarations on
  // custom-section fragments DO NOT reach the DragDropInfo's event resolution
  // mLocals. The alias is silently undefined, the resolver bails without binding,
  // `dropHandlerCount: 0`, and the drop event becomes a no-op. There is no
  // console error at default log level (only `Log.warning`), so all four prior
  // attempts at fixing #70 (#86, #94, #113, #123) shipped without any way to
  // notice the handler was never actually wired.
  //
  // Path #3 IS reliable: the resolver walks `globalThis` token-by-token. Since
  // `sap.ui.define` does NOT auto-publish the module export to its sap-namespace
  // path (that behavior was opt-in via the older `sap.ui.namespace` API), we
  // publish it ourselves below. The fragment's `drop=` attribute then uses the
  // fully-qualified path. The ugliness is the price of working through FE V4's
  // custom-section fragment loader; it's the same trick FE itself uses for the
  // few edge cases where its templating framework can't piggyback on a controller.
  //
  // See `ItemReorder.fragment.xml` next door for the matching `drop=` attribute.
  // Drag is gated by `enabled="{= !%{IsActiveEntity} }"` on the DragDropInfo so
  // the handler only fires in draft mode (active rows would silently no-op on
  // setProperty).
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
      // without writing, which would put us back in the previous "drop fires
      // but rows snap back" state. Refuse the drop unless the dragged context
      // is in draft mode. The fragment's `enabled` binding gates this already,
      // but we double-check so a binding regression surfaces with a console
      // message instead of a silent fail.
      if (oDraggedContext.getProperty("IsActiveEntity") !== false) {
        // eslint-disable-next-line no-console
        console.warn("ItemReorder: drop fired against an active entity — ignoring (parent OP must be in draft/edit mode)");
        return;
      }

      var aNewOrder = aContexts.filter(function (_, i) { return i !== iDragIndex; });
      aNewOrder.splice(iDropIndex, 0, oDraggedContext);

      // Context#setProperty returns a Promise that resolves when the PATCH
      // against the draft completes. Await ALL of them before refreshing — V4
      // ODataListBinding#refresh() throws if any pending changes exist, and we
      // need the server-side draft to hold the new itemOrder values before the
      // re-fetch so $orderby returns the rows in the right order.
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
      // PATCHed values. We can't use `oBinding.sort([new Sorter("itemOrder")])`
      // here: V4 treats same-path sorters as unchanged (since 1.97.0) and the
      // call becomes a silent no-op, leaving the cached row order intact —
      // that's the original "rows snap back" symptom.
      try {
        oBinding.refresh();
      } catch (oErr) {
        // eslint-disable-next-line no-console
        console.error("ItemReorder: oBinding.refresh() failed after reorder", oErr);
      }
    }
  };

  // Publish to the sap-namespace path so the fragment's
  // `drop="sap.tutorials.admin.groups.ext.ItemReorderHandler.onDrop"`
  // attribute resolves via globalThis walking. See header comment.
  /* global globalThis */
  var g = (typeof globalThis !== "undefined" ? globalThis : window);
  g.sap = g.sap || {};
  g.sap.tutorials = g.sap.tutorials || {};
  g.sap.tutorials.admin = g.sap.tutorials.admin || {};
  g.sap.tutorials.admin.groups = g.sap.tutorials.admin.groups || {};
  g.sap.tutorials.admin.groups.ext = g.sap.tutorials.admin.groups.ext || {};
  g.sap.tutorials.admin.groups.ext.ItemReorderHandler = Handler;

  return Handler;
});
