sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.tutorials.Component", {
    metadata: { manifest: "json" },

    // #617 Task 14 — Rewrite mainService.uri to /author/ when the shell
    // signals the current user is an author. The admin-shell publishes a
    // window.__tutorialPlatform global containing a servicePathByNavKey map
    // built from navigation.json (entries with adminPath/authorPath). This
    // runs before AppComponent.init so the override applies to the OData
    // model instantiated from the manifest's `models[""]` block.
    init: function () {
      try {
        var platform = window.__tutorialPlatform;
        var sPath = platform && platform.getServicePath && platform.getServicePath("tutorials");
        if (sPath) {
          var oManifest = this.getManifestEntry("sap.app");
          if (oManifest && oManifest.dataSources && oManifest.dataSources.mainService) {
            oManifest.dataSources.mainService.uri = sPath;
          }
        }
      } catch (e) { /* best-effort; never break tile boot */ }
      AppComponent.prototype.init.apply(this, arguments);
    }
  });
});
