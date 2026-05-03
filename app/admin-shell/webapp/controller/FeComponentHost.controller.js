sap.ui.define([
  "sap/ui/core/mvc/Controller"
], function (Controller) {
  "use strict";

  return Controller.extend("sap.tutorials.admin.shell.controller.FeComponentHost", {
    onComponentCreated: function (oEvent) {
      var oComponent = oEvent.getParameter("component");
      if (!oComponent) return;

      var oRouter = oComponent.getRouter();
      if (!oRouter) return;

      var oHashChanger = oRouter.getHashChanger();
      if (!oHashChanger) return;

      // Save originals — the hash changer is shared with the shell router
      var fnOrigGetHash = oHashChanger.getHash.bind(oHashChanger);
      var fnOrigSetHash = oHashChanger.setHash.bind(oHashChanger);
      var fnOrigReplaceHash = oHashChanger.replaceHash.bind(oHashChanger);

      // Temporarily patch so initialize() sees empty hash → matches root route
      oHashChanger.getHash = function () { return ""; };
      oHashChanger.setHash = function () {};
      oHashChanger.replaceHash = function () {};

      oRouter.stop();
      oRouter.initialize();
      oRouter.stop();

      // Restore immediately — shell routing must remain functional
      oHashChanger.getHash = fnOrigGetHash;
      oHashChanger.setHash = fnOrigSetHash;
      oHashChanger.replaceHash = fnOrigReplaceHash;
    }
  });
});
