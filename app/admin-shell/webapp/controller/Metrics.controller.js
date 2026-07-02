sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel"
], function (Controller, JSONModel) {
  "use strict";

  var POLL_MS = 30000;

  function pctDisplay(hits, total) {
    if (!total) return "—";
    return ((hits / total) * 100).toFixed(1) + "% (" + hits + "/" + total + ")";
  }

  function outcomeState(outcome) {
    if (outcome === "committed") return "Success";
    if (outcome === "aborted") return "Warning";
    return "Error";
  }

  return Controller.extend("sap.tutorials.admin.shell.controller.Metrics", {

    onInit: function () {
      this._model = new JSONModel({
        cacheHitRateDisplay: "—",
        cacheHitRateState: "None",
        cacheContentHitRateDisplay: "—",
        cacheRenderHitRateDisplay: "—",
        cacheBytesDisplay: "—",
        cacheEvicts: 0,
        dbWrapEnabled: false,
        dbAcquireP50Display: "—",
        dbAcquireP95Display: "—",
        dbAcquireP99Display: "—",
        dbPoolTimeouts: 0,
        recentPublishes: [],
        publish7dP50: 0, publish7dP95: 0, publish7dP99: 0,
        instanceId: "—", uptimeSec: 0, generatedAt: "—"
      });
      this.getView().setModel(this._model);

      var oRouter = this.getOwnerComponent().getRouter();
      var oRoute = oRouter.getRoute("metrics");
      if (oRoute) {
        oRoute.attachPatternMatched(this._onEntered, this);
      }
    },

    _onEntered: function () {
      this._refresh();
      this._loadHistory();
      if (this._pollTimer) clearInterval(this._pollTimer);
      this._pollTimer = setInterval(this._refresh.bind(this), POLL_MS);
      if (this._historyTimer) clearInterval(this._historyTimer);
      this._historyTimer = setInterval(this._loadHistory.bind(this), 5 * 60000);
    },

    onExit: function () {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
      if (this._historyTimer) { clearInterval(this._historyTimer); this._historyTimer = null; }
    },

    _refresh: function () {
      var self = this;
      // Absolute URL — approuter routes /admin/* to srv. XSUAA session cookie
      // is included automatically for same-origin fetches.
      fetch("/admin/getMetricsSnapshot()", {
        credentials: "include",
        headers: { Accept: "application/json" }
      }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      }).then(function (wrap) {
        // CAP function returning String: OData wraps as { value: '{json}' }.
        var inner = typeof wrap.value === "string" ? JSON.parse(wrap.value) : wrap;
        self._applySnapshot(inner);
      }).catch(function (err) {
        // eslint-disable-next-line no-console
        console.warn("[metrics tile] refresh failed:", err.message);
      });
    },

    _applySnapshot: function (envelope) {
      var s = envelope.snapshot || {};
      var c = s.counters || {};
      var g = s.gauges || {};
      var contentHits = c["content.cache.hit"] || 0;
      var contentMisses = c["content.cache.miss"] || 0;
      var contentTotal = contentHits + contentMisses;
      var renderHits = c["render.cache.hit"] || 0;
      var renderMisses = c["render.cache.miss"] || 0;
      var renderTotal = renderHits + renderMisses;
      var overallHits = contentHits + renderHits;
      var overallTotal = contentTotal + renderTotal;
      var overallRate = overallTotal ? (overallHits / overallTotal) : 0;

      this._model.setProperty("/cacheHitRateDisplay", pctDisplay(overallHits, overallTotal));
      this._model.setProperty("/cacheHitRateState",
        overallTotal === 0 ? "None" :
        overallRate > 0.8 ? "Success" :
        overallRate > 0.5 ? "Warning" : "Error");
      this._model.setProperty("/cacheContentHitRateDisplay", pctDisplay(contentHits, contentTotal));
      this._model.setProperty("/cacheRenderHitRateDisplay", pctDisplay(renderHits, renderTotal));
      this._model.setProperty("/cacheBytesDisplay",
        g["cache.bytes"] != null ? (g["cache.bytes"] / 1024 / 1024).toFixed(1) + " MB" : "—");
      this._model.setProperty("/cacheEvicts", c["cache.evict"] || 0);
      this._model.setProperty("/dbWrapEnabled", !!envelope.dbWrapEnabled);
      this._model.setProperty("/dbPoolTimeouts", c["db.pool.timeout"] || 0);
      this._model.setProperty("/instanceId", envelope.instanceId || "—");
      this._model.setProperty("/uptimeSec", envelope.uptimeSec || 0);
      this._model.setProperty("/generatedAt", envelope.generatedAt || "—");
    },

    _loadHistory: function () {
      this._loadRecentPublishes();
      this._load7dPercentiles();
    },

    _loadRecentPublishes: function () {
      var self = this;
      // AnalyticsService is mounted at /admin/analytics (see srv/analytics-service.cds @path)
      var url = "/admin/analytics/PublishTimings"
              + "?$select=createdAt,mode,totalMs,outcome,slugCount"
              + "&$orderby=createdAt%20desc&$top=20";
      fetch(url, { credentials: "include", headers: { Accept: "application/json" } })
        .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function (body) {
          var rows = (body.value || []).map(function (r) {
            return {
              createdAtDisplay: r.createdAt ? new Date(r.createdAt).toLocaleString() : "",
              mode: r.mode || "—",
              totalMs: r.totalMs || 0,
              outcome: r.outcome || "—",
              outcomeState: outcomeState(r.outcome)
            };
          });
          self._model.setProperty("/recentPublishes", rows);
        })
        .catch(function (err) {
          // eslint-disable-next-line no-console
          console.warn("[metrics tile] recent publishes load failed:", err.message);
        });
    },

    _load7dPercentiles: function () {
      var self = this;
      var cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
      var url = "/admin/analytics/PublishTimings"
              + "?$select=totalMs&$filter=outcome eq 'committed' and createdAt ge " + cutoff
              + "&$top=5000";
      fetch(url, { credentials: "include", headers: { Accept: "application/json" } })
        .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function (body) {
          var nums = (body.value || []).map(function (r) { return r.totalMs || 0; }).sort(function (a, b) { return a - b; });
          var pct = function (p) {
            if (!nums.length) return 0;
            return nums[Math.min(nums.length - 1, Math.floor(nums.length * p))];
          };
          self._model.setProperty("/publish7dP50", pct(0.50));
          self._model.setProperty("/publish7dP95", pct(0.95));
          self._model.setProperty("/publish7dP99", pct(0.99));
        })
        .catch(function (err) {
          // eslint-disable-next-line no-console
          console.warn("[metrics tile] 7d percentiles load failed:", err.message);
        });
    }
  });
});
