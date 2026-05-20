sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension",
  "sap/ui/model/json/JSONModel",
  "sap/ui/core/Fragment",
  "sap/m/MessageBox",
  "sap/m/MessageStrip"
], function (ControllerExtension, JSONModel, Fragment, MessageBox) {
  "use strict";

  return ControllerExtension.extend("sap.tutorials.admin.tags.ext.TagImportController", {

    override: {
      onInit: function () {
        this._dialog = null;
      }
    },

    _initialState: function () {
      return {
        state: "upload",
        uploadTab: "file",
        format: "csv",
        payload: "",
        rows: [],
        summaryText: "",
        summaryStripType: "Information",
        strategy: "upsert",
        resultText: "",
        token: null
      };
    },

    _ensureViewState: function () {
      const view = this.base.getView();
      let model = view.getModel("viewState");
      if (!model) {
        model = new JSONModel(this._initialState());
        view.setModel(model, "viewState");
      } else {
        model.setData(this._initialState());
      }
      return model;
    },

    openTagImportDialog: function () {
      const view = this.base.getView();
      this._ensureViewState();
      const open = (dlg) => { this._dialog = dlg; dlg.open(); };
      if (this._dialog) {
        open(this._dialog);
      } else {
        Fragment.load({
          id: view.getId(),
          name: "sap.tutorials.admin.tags.ext.TagImportDialog",
          controller: this
        }).then((dlg) => { view.addDependent(dlg); open(dlg); });
      }
    },

    onFileSelected: function (oEvent) {
      const file = oEvent.getParameter("files") && oEvent.getParameter("files")[0];
      if (!file) return;
      const view = this.base.getView();
      const model = view.getModel("viewState");
      const reader = new FileReader();
      reader.onload = (e) => {
        model.setProperty("/payload", e.target.result);
        const fmt = file.name.toLowerCase().endsWith(".json") ? "json" : "csv";
        model.setProperty("/format", fmt);
      };
      reader.readAsText(file);
    },

    onPreview: function () {
      const view = this.base.getView();
      const model = view.getModel("viewState");
      const payload = model.getProperty("/payload");
      const format  = model.getProperty("/format");
      const ctx = view.getBindingContext();
      const odataModel = view.getModel();
      const op = odataModel.bindContext("/previewTagImport(...)");
      op.setParameter("payload", payload);
      op.setParameter("format",  format);
      op.execute().then(() => {
        const result = op.getBoundContext().getObject();
        model.setProperty("/token", result.token);
        model.setProperty("/rows", result.rows.map((r) => ({
          ...r,
          statusLabel: this._statusLabel(r.status),
          statusState: this._statusState(r.status)
        })));
        const s = result.summary;
        model.setProperty("/summaryText", this._fmtSummary(s));
        model.setProperty("/summaryStripType",
          s.invalid > 0 ? "Warning" : (s.conflict > 0 ? "Information" : "Success"));
        model.setProperty("/state", "preview");
      }).catch((err) => MessageBox.error(this._fmtError(err)));
    },

    onCommit: function () {
      const view = this.base.getView();
      const model = view.getModel("viewState");
      const odataModel = view.getModel();
      const op = odataModel.bindContext("/commitTagImport(...)");
      op.setParameter("token", model.getProperty("/token"));
      op.setParameter("strategy", model.getProperty("/strategy"));
      op.execute().then(() => {
        const r = op.getBoundContext().getObject();
        model.setProperty("/resultText", this._fmtResult(r));
        model.setProperty("/state", "done");
        if (this.base?.extensionAPI?.refresh) {
          this.base.extensionAPI.refresh();
        } else {
          const lr = view.byId("fe::table::Tags::LineItem-innerTable");
          if (lr && lr.getBinding("items")) lr.getBinding("items").refresh();
        }
      }).catch((err) => {
        const status = err && err.error && err.error.code;
        if (status === "410" || /expired/i.test(err.message || "")) {
          model.setProperty("/state", "upload");
          MessageBox.warning(this.base.getView().getModel("i18n").getResourceBundle()
            .getText("tagImport.error.expired"));
          return;
        }
        MessageBox.error(this._fmtError(err));
      });
    },

    onBack: function () {
      this.base.getView().getModel("viewState").setProperty("/state", "upload");
    },

    onClose: function () {
      if (this._dialog) this._dialog.close();
    },

    _statusLabel: function (status) {
      const bundle = this.base.getView().getModel("i18n").getResourceBundle();
      return bundle.getText("tagImport.status." + status);
    },

    _statusState: function (status) {
      switch (status) {
        case "new":      return "Success";
        case "conflict": return "Warning";
        case "invalid":  return "Error";
        default:         return "None";
      }
    },

    _fmtSummary: function (s) {
      const bundle = this.base.getView().getModel("i18n").getResourceBundle();
      return bundle.getText("tagImport.summary", [s.new_, s.conflict, s.invalid, s.total]);
    },

    _fmtResult: function (r) {
      const bundle = this.base.getView().getModel("i18n").getResourceBundle();
      return bundle.getText("tagImport.result", [r.inserted, r.updated, r.skipped, r.total]);
    },

    _fmtError: function (err) {
      const bundle = this.base.getView().getModel("i18n").getResourceBundle();
      const detail = (err && err.error && err.error.message) || (err && err.message) || String(err);
      return bundle.getText("tagImport.error.generic", [detail]);
    }

  });
});
