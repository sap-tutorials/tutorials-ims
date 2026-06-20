sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, MessageToast, MessageBox) {
  "use strict";
  return Controller.extend("sap.tutorials.admin.navigator.controller.Settings", {
    onInit: function () {
      var oJSON = new JSONModel({
        includeNestedGroups: false
      });
      this.getView().setModel(oJSON, "settings");
      this._loadSettings();
    },

    _loadSettings: function () {
      var oModel = this.getView().getModel("settings");
      fetch("/admin/NavigatorSettings", {
        credentials: "include",
        headers: { "Accept": "application/json" }
      })
        .then(function (res) {
          if (!res.ok) { throw new Error("HTTP " + res.status); }
          return res.json();
        })
        .then(function (data) {
          oModel.setData({
            includeNestedGroups: !!data.includeNestedGroups
          });
        })
        .catch(function (err) {
          MessageToast.show("Failed to load settings: " + err.message);
        });
    },

    onReload: function () {
      this._loadSettings();
    },

    onSave: function () {
      var data = this.getView().getModel("settings").getData();
      var body = {
        includeNestedGroups: !!data.includeNestedGroups
      };

      fetch("/admin/$metadata", {
        method: "HEAD",
        credentials: "include",
        headers: { "x-csrf-token": "fetch" }
      })
        .then(function (res) {
          return res.headers.get("x-csrf-token") || "";
        })
        .then(function (token) {
          return fetch("/admin/NavigatorSettings", {
            method: "PATCH",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "x-csrf-token": token
            },
            body: JSON.stringify(body)
          });
        })
        .then(function (res) {
          if (!res.ok) { throw new Error("HTTP " + res.status); }
          MessageToast.show("Saved");
        })
        .catch(function (err) {
          MessageBox.error("Save failed: " + err.message);
        });
    }
  });
});
