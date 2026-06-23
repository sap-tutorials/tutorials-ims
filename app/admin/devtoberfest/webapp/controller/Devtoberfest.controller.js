sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, MessageToast, MessageBox) {
  "use strict";

  return Controller.extend("sap.tutorials.admin.devtoberfest.controller.Devtoberfest", {

    onInit: function () {
      // Bind a snapshot of the original termsVersion so we can show the
      // version-bump warning strip when the admin edits it. The change
      // handler is attached only AFTER the snapshot resolves so we never
      // miss the comparison if the user edits quickly.
      var oModel = this.getOwnerComponent().getModel();
      oModel.bindContext("/DevtoberfestConfig").requestObject().then((cfg) => {
        this._originalTermsVersion = cfg.termsVersion;
        var oVersionInput = this.byId("termsVersionInput");
        if (oVersionInput) {
          oVersionInput.attachChange((evt) => {
            var newVal = parseInt(evt.getParameter("value"), 10);
            var strip = this.byId("versionWarning");
            if (strip) {
              strip.setVisible(newVal !== this._originalTermsVersion);
            }
          });
        }
      });
    },

    formatTimestamp: function (iso) {
      if (!iso) return "";
      return new Date(iso).toLocaleString();
    },

    onSave: function () {
      var oModel = this.getOwnerComponent().getModel();
      oModel.submitBatch("$auto").then(() => {
        MessageToast.show(this.getBundle().getText("toastSaved"));
        var strip = this.byId("versionWarning");
        if (strip) strip.setVisible(false);
        // Update the snapshot so future version edits compare against the saved value
        this._originalTermsVersion = oModel.getProperty("/DevtoberfestConfig/termsVersion");
      }).catch((err) => {
        var detail = (err && err.error && err.error.message && err.error.message.value)
          || (err && err.message)
          || "Unknown error";
        MessageToast.show(this.getBundle().getText("toastSaveFailed") + ": " + detail);
      });
    },

    onDiscard: function () {
      var oModel = this.getOwnerComponent().getModel();
      var bundle = this.getBundle();
      if (!oModel.hasPendingChanges()) {
        MessageToast.show(bundle.getText("toastNoChanges"));
        return;
      }
      MessageBox.confirm(bundle.getText("confirmDiscard"), {
        title: bundle.getText("buttonDiscard"),
        onClose: (action) => {
          if (action === MessageBox.Action.OK) {
            oModel.resetChanges();
            oModel.refresh();
            var strip = this.byId("versionWarning");
            if (strip) strip.setVisible(false);
            MessageToast.show(bundle.getText("toastDiscarded"));
          }
        }
      });
    },

    getBundle: function () {
      return this.getOwnerComponent().getModel("i18n").getResourceBundle();
    }
  });
});
