sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, MessageToast, MessageBox) {
  "use strict";
  return Controller.extend("sap.tutorials.admin.joule.controller.Settings", {
    onInit: function () {
      var oJSON = new JSONModel({
        enabled: false,
        deploymentId: "",
        modelName: "",
        temperature: null,
        maxTokens: null,
        maxRequestsPerUser: 100,
        bannerText: ""
      });
      this.getView().setModel(oJSON, "settings");
      this._loadSettings();
    },

    onAfterRendering: function () {
      // Browser password/email-fill plugins race the async settings load and
      // overwrite empty inputs before setData() lands. Disable autofill on
      // every native <input> in the form.
      var $root = this.getView().$();
      if ($root && $root.length) {
        $root.find("input").attr("autocomplete", "off")
          .attr("name", function (i) { return "joule-cfg-" + i; });
      }
    },

    _loadSettings: function () {
      var oModel = this.getView().getModel("settings");
      fetch("/admin/ChatSettings", {
        credentials: "include",
        headers: { "Accept": "application/json" }
      })
        .then(function (res) {
          if (!res.ok) { throw new Error("HTTP " + res.status); }
          return res.json();
        })
        .then(function (data) {
          oModel.setData({
            enabled: !!data.enabled,
            deploymentId: data.deploymentId || "",
            modelName: data.modelName || "",
            temperature: data.temperature != null ? data.temperature : null,
            maxTokens: data.maxTokens != null ? data.maxTokens : null,
            maxRequestsPerUser: data.maxRequestsPerUser || 100,
            bannerText: data.bannerText || ""
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
      var temp = data.temperature === "" || data.temperature == null ? null : Number(data.temperature);
      var tokens = data.maxTokens === "" || data.maxTokens == null ? null : parseInt(data.maxTokens, 10);
      var body = {
        enabled: !!data.enabled,
        deploymentId: data.deploymentId || "",
        modelName: data.modelName || null,
        temperature: temp,
        maxTokens: tokens,
        maxRequestsPerUser: parseInt(data.maxRequestsPerUser, 10) || 100,
        bannerText: data.bannerText || ""
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
          return fetch("/admin/ChatSettings", {
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
