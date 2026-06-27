sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.tags.Component", {
    metadata: { manifest: "json" },

    // #617 Task 14 — see app/admin/tutorials/webapp/Component.js for rationale.
    init: function () {
      try {
        var platform = window.__tutorialPlatform;
        var sPath = platform && platform.getServicePath && platform.getServicePath("tags");
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
