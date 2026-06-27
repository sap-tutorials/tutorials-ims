sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.feedback.Component", {
    metadata: { manifest: "json" },

    // #617 Task 14 — see app/admin/tutorials/webapp/Component.js for rationale.
    // The feedback tile backs both `feedbackList` and `feedbackDashboard` nav
    // entries; both carry the same adminPath/authorPath, so we probe whichever
    // resolves first.
    init: function () {
      try {
        var platform = window.__tutorialPlatform;
        if (platform && platform.getServicePath) {
          var sPath = platform.getServicePath("feedbackList")
                   || platform.getServicePath("feedbackDashboard");
          if (sPath) {
            var oManifest = this.getManifestEntry("sap.app");
            if (oManifest && oManifest.dataSources && oManifest.dataSources.mainService) {
              oManifest.dataSources.mainService.uri = sPath;
            }
          }
        }
      } catch (e) { /* best-effort; never break tile boot */ }
      AppComponent.prototype.init.apply(this, arguments);
    }
  });
});
