sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension"
], function (ControllerExtension) {
  "use strict";

  return ControllerExtension.extend("sap.tutorials.admin.tutorials.ext.AskJoule", {

    onAskJoule: function () {
      var oContext = this.getView().getBindingContext();
      if (!oContext) return;
      var oData = oContext.getObject();
      if (!oData) return;
      var sTitle = oData.title || "";
      var sSlug  = oData.slug  || "";
      if (!sSlug) return;

      var sText = 'Please suggest improvements for the tutorial "' + sTitle +
                  '" (slug: ' + sSlug + '). Consider feedback comments, NPS score, ' +
                  'step structure, and clarity.';

      var oWin = window.parent || window;
      if (oWin.joule && typeof oWin.joule.openWithMessage === "function") {
        oWin.joule.openWithMessage({ text: sText });
      }
    }

  });
});
