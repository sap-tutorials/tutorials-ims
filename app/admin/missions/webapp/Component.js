sap.ui.define([
  "sap/fe/core/AppComponent",
  // Eager-load the Path Items Task-column handler so it is in the module cache
  // BEFORE Fiori Elements clones the completionPaths LineItem column template.
  //
  // TaskColumn.fragment.xml pulls this module via core:require. Admin child
  // components are raw-copied into the shell (app/admin-shell/scripts/copy-
  // components.js) without a per-component `ui5 build`, so there is no
  // Component-preload.js bundling it — the module otherwise loads lazily and
  // loses the race against FE's synchronous template-clone binding evaluation.
  // When the `handler` alias is unresolved at clone time, the
  // `showValueHelp="{= ${taskType} !== 'CHECKPOINT' }"` expression binding
  // silently degrades to a plain path binding on `taskType` (coerced to a
  // non-boolean) → the F4 value-help icon disappears from the Task column.
  // Declaring it here forces resolution+caching before the factory runs.
  "sap/tutorials/admin/missions/ext/TaskColumnHandler"
], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.missions.Component", {
    metadata: { manifest: "json" }
  });
});
