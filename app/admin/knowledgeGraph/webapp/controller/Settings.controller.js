sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, MessageToast, MessageBox) {
  "use strict";

  return Controller.extend("sap.tutorials.admin.knowledgeGraph.controller.Settings", {
    onInit: function () {
      var oJSON = new JSONModel({
        enabled: false,
        extractBuildCap: null,
        mergeSimThreshold: null,
        mergeSimThresholdExtract: null
      });
      this.getView().setModel(oJSON, "settings");
      this._loadSettings();
    },

    _loadSettings: function () {
      var oModel = this.getView().getModel("settings");
      fetch("/admin/KnowledgeGraphSettings", {
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
            extractBuildCap: data.extractBuildCap != null ? data.extractBuildCap : null,
            mergeSimThreshold: data.mergeSimThreshold != null ? data.mergeSimThreshold : null,
            mergeSimThresholdExtract: data.mergeSimThresholdExtract != null ? data.mergeSimThresholdExtract : null
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
      var cap = data.extractBuildCap === "" || data.extractBuildCap == null ? null : parseInt(data.extractBuildCap, 10);
      var t1  = data.mergeSimThreshold === "" || data.mergeSimThreshold == null ? null : Number(data.mergeSimThreshold);
      var t2  = data.mergeSimThresholdExtract === "" || data.mergeSimThresholdExtract == null ? null : Number(data.mergeSimThresholdExtract);
      var body = {
        enabled: !!data.enabled,
        extractBuildCap: cap,
        mergeSimThreshold: t1,
        mergeSimThresholdExtract: t2
      };

      // CSRF round-trip: HEAD /admin/$metadata returns the token; PATCH echoes it.
      // CAP enforces CSRF on writes; no exemption for /admin/. Joule does the same.
      fetch("/admin/$metadata", {
        method: "HEAD",
        credentials: "include",
        headers: { "x-csrf-token": "fetch" }
      })
        .then(function (res) {
          return res.headers.get("x-csrf-token") || "";
        })
        .then(function (token) {
          return fetch("/admin/KnowledgeGraphSettings", {
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
