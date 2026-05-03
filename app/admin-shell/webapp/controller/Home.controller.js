sap.ui.define([
  "sap/ui/core/mvc/Controller"
], function (Controller) {
  "use strict";

  return Controller.extend("sap.tutorials.admin.shell.controller.Home", {
    onTilePress: function (oEvent) {
      var sNavKey = oEvent.getSource().data("navKey");
      this.getOwnerComponent().getRouter().navTo(sNavKey);
    }
  });
});
