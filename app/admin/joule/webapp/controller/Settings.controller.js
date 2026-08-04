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
        codeCheckEnabled: false,
        // Issue #172 pilot master flag. Default false to mirror the schema
        // default (db/schema.cds:530). When off, the public /api/ChatConfig
        // singleton reports branchingEnabled=false and the Learning
        // Preferences island in /me/ shows the "Branching is currently
        // disabled platform-wide" info strip. Flipping on activates the
        // branch recommender, getBranchRecommendation Joule tool, and
        // mission alt-group rendering (see docs/authors/pilot-runbook.md).
        branchingEnabled: false,
        // KG community peers (#1126). Default false to mirror the schema
        // default (db/schema.cds:667). Flipping on registers the
        // findCommunityPeers Joule tool; the budget caps the nightly
        // labeling job's per-day LLM calls (db/schema.cds:672).
        communityPeersEnabled: false,
        communityLabelLlmBudgetPerDay: 50,
        // Puzzle hint Joule tool. Default false to mirror the schema default
        // (db/schema.cds). When on, the puzzleHint tool is registered on
        // crossword puzzle pages so Joule can coach on cryptic clues without
        // revealing answers.
        puzzleHintEnabled: false,
        // Knowledge Graph Joule tool flags. These gate LLM-facing tool
        // registration in the chat orchestrator. Defaults mirror the schema
        // (db/schema.cds): kgPathBetweenEnabled OFF (#445), the other three ON
        // (cheap, cache-reused). kgPathBetweenEnabled had no UI toggle before —
        // it could only be flipped via a direct PATCH to /admin/ChatSettings.
        kgPathBetweenEnabled: false,
        kgSearchExpansionEnabled: true,
        searchKgRerankEnabled: true,
        kgRelatedContentEnabled: true,
        // A2A (Agent-to-Agent) endpoint config (#1220). a2aEnabled defaults
        // true to mirror the schema default (db/schema.cds). When enabled, the
        // Agent Card endpoint at /.well-known/agent-card.json is advertised and
        // a2aPublicBaseUrl overrides the auto-detected platform host.
        a2aEnabled: true,
        a2aPublicBaseUrl: "",
        a2aTokenUrl: "",
        // ANS master switch (#1468). Default false to mirror the schema default
        // (db/schema.cds:755). When on, SAP Alert Notification push alerts fire
        // for publish-rejects, scheduled-job failures, and rebuild-dispatch
        // failures (resolved via srv/lib/runtime-config/alert-settings.js).
        alertsEnabled: false
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
            codeCheckEnabled: !!data.codeCheckEnabled,
            branchingEnabled: !!data.branchingEnabled,
            communityPeersEnabled: !!data.communityPeersEnabled,
            communityLabelLlmBudgetPerDay: data.communityLabelLlmBudgetPerDay != null ? data.communityLabelLlmBudgetPerDay : 50,
            puzzleHintEnabled: !!data.puzzleHintEnabled,
            // KG tool flags. Defaults-when-null mirror the schema: kgPathBetween
            // OFF, the other three ON (use ?? so an absent field renders ON, not OFF).
            kgPathBetweenEnabled: !!data.kgPathBetweenEnabled,
            kgSearchExpansionEnabled: data.kgSearchExpansionEnabled ?? true,
            searchKgRerankEnabled: data.searchKgRerankEnabled ?? true,
            // #1171 community-overlap search-rank weight. Null/undefined → 0 (OFF).
            communityRankWeight: data.communityRankWeight != null ? Number(data.communityRankWeight) : 0,
            kgRelatedContentEnabled: data.kgRelatedContentEnabled ?? true,
            a2aEnabled: data.a2aEnabled ?? true,
            a2aPublicBaseUrl: data.a2aPublicBaseUrl || "",
            a2aTokenUrl: data.a2aTokenUrl || "",
            alertsEnabled: !!data.alertsEnabled
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
        codeCheckEnabled: !!data.codeCheckEnabled,
        branchingEnabled: !!data.branchingEnabled,
        communityPeersEnabled: !!data.communityPeersEnabled,
        communityLabelLlmBudgetPerDay: parseInt(data.communityLabelLlmBudgetPerDay, 10) || 50,
        puzzleHintEnabled: !!data.puzzleHintEnabled,
        kgPathBetweenEnabled: !!data.kgPathBetweenEnabled,
        kgSearchExpansionEnabled: !!data.kgSearchExpansionEnabled,
        searchKgRerankEnabled: !!data.searchKgRerankEnabled,
        // #1171: clamp to [0,5]; blank/NaN → 0 (OFF).
        communityRankWeight: (function () {
          var w = Number(data.communityRankWeight);
          if (!isFinite(w) || w < 0) { return 0; }
          return w > 5 ? 5 : w;
        })(),
        kgRelatedContentEnabled: !!data.kgRelatedContentEnabled,
        a2aEnabled: !!data.a2aEnabled,
        a2aPublicBaseUrl: data.a2aPublicBaseUrl || "",
        a2aTokenUrl: data.a2aTokenUrl || "",
        alertsEnabled: !!data.alertsEnabled
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

    // Issue #943: mirrors onSeedEmbeddings but targets Concepts.embedding
    // (KG concept-level embeddings) rather than TutorialEmbedding. The
    // backend action runs synchronously and returns { processed, failed,
    // latencyMs } — surfaced as a toast on completion.
    onSeedConceptEmbeddings: function () {
      var self = this;
      var bundle = self.getView().getModel("i18n").getResourceBundle();
      MessageToast.show(bundle.getText("seedConceptRunning"));
      fetch("/admin/$metadata", {
        method: "HEAD",
        credentials: "include",
        headers: { "x-csrf-token": "fetch" }
      })
        .then(function (res) {
          return res.headers.get("x-csrf-token") || "";
        })
        .then(function (token) {
          return fetch("/admin/ChatSettings/AdminService.seedConceptEmbeddings", {
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
          return res.json();
        })
        .then(function (payload) {
          // OData wraps action results in { value: {...} } or returns the flat
          // object depending on protocol version. Accept both shapes.
          var summary = payload && payload.value ? payload.value : payload;
          var processed = summary && summary.processed != null ? summary.processed : 0;
          var failed = summary && summary.failed != null ? summary.failed : 0;
          var latencyMs = summary && summary.latencyMs != null ? summary.latencyMs : 0;
          MessageToast.show(bundle.getText("seedConceptSummary", [processed, failed, latencyMs]));
        })
        .catch(function (err) {
          MessageBox.error("Concept seed failed: " + err.message);
        });
    },

    // #1469: fire an on-demand end-to-end ANS test alert via the bound
    // AdminService.sendTestAlert action, and report the outcome. Mirrors
    // onSeedConceptEmbeddings' CSRF-fetch → POST → parse shape.
    onSendTestAlert: function () {
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
          return fetch("/admin/ChatSettings/AdminService.sendTestAlert", {
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
          return res.json();
        })
        .then(function (payload) {
          // OData wraps action results in { value: {...} } on some protocol
          // versions and returns the flat object on others. Accept both.
          var r = payload && payload.value ? payload.value : payload;
          var outcome = r && r.outcome ? r.outcome : "error";
          if (outcome === "delivered") {
            MessageToast.show("Test alert sent (eventType AlertingTest). Check the devrel-oncall inbox.");
          } else if (outcome === "disabled") {
            MessageBox.warning("Alerting is disabled — enable ANS push alerts above, click Save, then retry.");
          } else {
            MessageBox.error("Test alert failed: " + ((r && r.reason) || "unknown error"));
          }
        })
        .catch(function (err) {
          MessageBox.error("Test alert failed: " + err.message);
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
