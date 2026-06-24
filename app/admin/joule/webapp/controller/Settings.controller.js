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
        bannerText: "",
        ragEnabled: false,
        embeddingModel: "",
        embeddingTopK: 5,
        embeddingMinScore: 0.25,
        // AI grading sibling flags. Default false to mirror the schema default
        // (db/schema.cds:519,523) — flipping these on starts AI Core token
        // consumption per learner submission. The help text under each switch
        // in the view makes the cost trade-off explicit.
        validateAnswerEnabled: false,
        codeCheckEnabled: false
      });
      this.getView().setModel(oJSON, "settings");
      this._loadSettings();
      this._refreshStats();
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
            bannerText: data.bannerText || "",
            ragEnabled: !!data.ragEnabled,
            embeddingModel: data.embeddingModel || "",
            embeddingTopK: data.embeddingTopK != null ? data.embeddingTopK : 5,
            embeddingMinScore: data.embeddingMinScore != null ? data.embeddingMinScore : 0.25,
            validateAnswerEnabled: !!data.validateAnswerEnabled,
            codeCheckEnabled: !!data.codeCheckEnabled
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
      var self = this;
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
        bannerText: data.bannerText || "",
        ragEnabled: !!data.ragEnabled,
        embeddingModel: data.embeddingModel || null,
        embeddingTopK: parseInt(data.embeddingTopK, 10) || 5,
        embeddingMinScore: data.embeddingMinScore === "" || data.embeddingMinScore == null ? null : Number(data.embeddingMinScore),
        validateAnswerEnabled: !!data.validateAnswerEnabled,
        codeCheckEnabled: !!data.codeCheckEnabled
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
          self._refreshStats();
        })
        .catch(function (err) {
          MessageBox.error("Save failed: " + err.message);
        });
    },

    onSeedEmbeddings: function () {
      var self = this;
      fetch("/admin/$metadata", {
        method: "HEAD",
        credentials: "include",
        headers: { "x-csrf-token": "fetch" }
      })
        .then(function (res) {
          return res.headers.get("x-csrf-token") || "";
        })
        .then(function (token) {
          return fetch("/admin/ChatSettings/AdminService.seedEmbeddings", {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "x-csrf-token": token
            },
            body: JSON.stringify({})
          });
        })
        .then(function (res) {
          if (!res.ok) {
            return res.text().then(function (txt) {
              throw new Error(txt || "HTTP " + res.status);
            });
          }
          var bundle = self.getView().getModel("i18n").getResourceBundle();
          MessageToast.show(bundle.getText("seedRunning"));
          self._refreshStats();
        })
        .catch(function (err) {
          MessageBox.error("Seed failed: " + err.message);
        });
    },

    _refreshStats: function () {
      var self = this;
      fetch("/admin/embeddings/stats", {
        credentials: "include",
        headers: { "Accept": "application/json" }
      })
        .then(function (res) {
          if (!res.ok) { return null; }
          return res.json();
        })
        .then(function (stats) {
          if (!stats) { return; }
          var bundle = self.getView().getModel("i18n").getResourceBundle();
          stats.slugsDisplay = bundle.getText("ragStatsSlugs", [stats.slugsWithEmbeddings != null ? stats.slugsWithEmbeddings : 0, stats.slugs != null ? stats.slugs : 0]);
          stats.stepsDisplay = bundle.getText("ragStatsSteps", [stats.embeddedSteps != null ? stats.embeddedSteps : 0, stats.totalSteps != null ? stats.totalSteps : 0]);
          stats.lastRunDisplay = stats.lastRun
            ? bundle.getText("ragStatsLastRun", [new Date(stats.lastRun.startedAt).toLocaleString(), stats.lastRun.status])
            : "";
          self.getView().setModel(new JSONModel(stats), "stats");
        })
        .catch(function () {
          // stats are non-critical; don't disrupt the page
        });
    }
  });
});
