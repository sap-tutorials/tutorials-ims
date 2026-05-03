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

      oHashChanger.getHash = function () { return ""; };
      oHashChanger.setHash = function () {};
      oHashChanger.replaceHash = function () {};

      oRouter.stop();
      oRouter.initialize();
    }
  });
});
