sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Fragment",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, Fragment, JSONModel, MessageToast, MessageBox) {
  "use strict";

  function deriveExpiryState(expiresAt) {
    if (!expiresAt) return "None";
    var today = new Date();
    var expiry = new Date(expiresAt);
    var todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    var days = Math.floor((expiry.getTime() - todayUTC) / 86400000);
    if (days <= 0) return "Error";
    if (days <= 7) return "Warning";
    if (days <= 14) return "Information";
    return "None";
  }

  return Controller.extend("sap.tutorials.admin.secrets.controller.Secrets", {
    onInit: function () {
      this.getView().setModel(new JSONModel({ items: [] }), "secrets");
      this.getView().setModel(new JSONModel({}), "dialog");
      this._loadSecrets();
    },

    _loadSecrets: function () {
      var oModel = this.getView().getModel("secrets");
      fetch("/admin/Secrets", {
        credentials: "include",
        headers: { "Accept": "application/json" }
      })
        .then(function (res) {
          if (!res.ok) { throw new Error("HTTP " + res.status); }
          return res.json();
        })
        .then(function (body) {
          var items = (body.value || []).map(function (row) {
            row.expiryState = deriveExpiryState(row.expiresAt);
            return row;
          });
          oModel.setData({ items: items });
        })
        .catch(function (err) {
          MessageToast.show("Failed to load secrets: " + err.message);
        });
    },

    onRefresh: function () { this._loadSecrets(); },

    onAdd: function () {
      this.getView().getModel("dialog").setData({
        title: this.getView().getModel("i18n").getResourceBundle().getText("dialogTitleAdd"),
        isNew: true,
        ID: null,
        key: "",
        description: "",
        kind: "other",
        rotationOwner: "",
        rotationDocsUrl: "",
        expiresAt: null,
        lastRotatedAt: null
      });
      this._openDialog();
    },

    onEdit: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("secrets");
      var row = oCtx.getObject();
      this.getView().getModel("dialog").setData({
        title: this.getView().getModel("i18n").getResourceBundle().getText("dialogTitleEdit"),
        isNew: false,
        ID: row.ID,
        key: row.key,
        description: row.description || "",
        kind: row.kind || "other",
        rotationOwner: row.rotationOwner || "",
        rotationDocsUrl: row.rotationDocsUrl || "",
        expiresAt: row.expiresAt || null,
        lastRotatedAt: row.lastRotatedAt || null
      });
      this._openDialog();
    },

    onDelete: function (oEvent) {
      var self = this;
      var oCtx = oEvent.getSource().getBindingContext("secrets");
      var row = oCtx.getObject();
      var bundle = this.getView().getModel("i18n").getResourceBundle();
      MessageBox.confirm(bundle.getText("confirmDelete"), {
        onClose: function (sAction) {
          if (sAction !== MessageBox.Action.OK) { return; }
          self._withCsrf(function (token) {
            return fetch("/admin/Secrets(" + row.ID + ")", {
              method: "DELETE",
              credentials: "include",
              headers: { "x-csrf-token": token }
            });
          }).then(function () {
            MessageToast.show("Deleted");
            self._loadSecrets();
          }).catch(function (err) {
            MessageBox.error("Delete failed: " + err.message);
          });
        }
      });
    },

    _openDialog: function () {
      var self = this;
      if (!this._oDialog) {
        Fragment.load({
          id: this.getView().getId(),
          name: "sap.tutorials.admin.secrets.view.SecretDialog",
          controller: this
        }).then(function (oDialog) {
          self._oDialog = oDialog;
          self.getView().addDependent(oDialog);
          oDialog.open();
        });
      } else {
        this._oDialog.open();
      }
    },

    onDialogSave: function () {
      var self = this;
      var data = this.getView().getModel("dialog").getData();
      var body = {
        key: data.key,
        description: data.description || null,
        kind: data.kind || null,
        rotationOwner: data.rotationOwner || null,
        rotationDocsUrl: data.rotationDocsUrl || null,
        expiresAt: data.expiresAt || null,
        lastRotatedAt: data.lastRotatedAt || null
      };

      this._withCsrf(function (token) {
        if (data.isNew) {
          return fetch("/admin/Secrets", {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "x-csrf-token": token
            },
            body: JSON.stringify(body)
          });
        }
        return fetch("/admin/Secrets(" + data.ID + ")", {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-csrf-token": token
          },
          body: JSON.stringify(body)
        });
      }).then(function (res) {
        if (!res.ok) { throw new Error("HTTP " + res.status); }
        MessageToast.show("Saved");
        self._oDialog.close();
        self._loadSecrets();
      }).catch(function (err) {
        MessageBox.error("Save failed: " + err.message);
      });
    },

    onDialogCancel: function () {
      this._oDialog.close();
    },

    _withCsrf: function (fnAfterToken) {
      return fetch("/admin/$metadata", {
        method: "HEAD",
        credentials: "include",
        headers: { "x-csrf-token": "fetch" }
      }).then(function (res) {
        return res.headers.get("x-csrf-token") || "";
      }).then(fnAfterToken);
    }
  });
});
