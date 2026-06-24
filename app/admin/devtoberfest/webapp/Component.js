sap.ui.define(["sap/ui/core/UIComponent"], function (UIComponent) {
  "use strict";
  // PR #596: switched from sap/fe/core/AppComponent to plain UIComponent.
  // The tile uses hand-rolled `sap.m` controls (IconTabBar + ComboBox +
  // Table) inside `view/Devtoberfest.view.xml` — no Fiori Elements
  // ListReport / ObjectPage templates. Booting AppComponent for an
  // FE-free view was attempting tree-binding the OData service catalog
  // during initialization (line 1201 of ODataModel-dbg.js: `bindTree`),
  // which V4 doesn't support, throwing
  // `Unsupported operation: v4.ODataModel#bindTree` and aborting the
  // routing target before render — Tom hit this every time entering the
  // tile post-PR #588. Plain UIComponent skips that init path; the
  // controller's manual model binding (`oModel.bindContext`) takes over
  // and works.
  //
  // This matches the pattern of every other admin tile that uses custom
  // sap.m views (e.g. app/admin/secrets, app/admin/display) — only the
  // tiles that genuinely use FE ListReport/ObjectPage templates need
  // AppComponent.
  return UIComponent.extend("sap.tutorials.admin.devtoberfest.Component", {
    metadata: { manifest: "json" }
  });
});
