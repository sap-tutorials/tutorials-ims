sap.ui.define([], function () {
  "use strict";

  // ──────────────────────────────────────────────────────────────────────────
  // odata-batch.js — shared admin-shell helper (issue #1650)
  //
  // Tunnels a single OData V4 write (PATCH / DELETE / PUT) through
  //   POST /<service>$batch
  // using the OData V4 *JSON* batch format, so the request reaches the origin
  // as a plain POST.
  //
  // WHY: developers.sap.com (PROD) is fronted by Akamai, which rejects the bare
  // `PATCH`/`DELETE` HTTP verbs at the edge with `501 Unsupported Request`
  // (body references errors.edgesuite.net) before the request ever reaches the
  // approuter/CAP origin. Fiori Elements admin pages never hit this because the
  // UI5 OData V4 model batches EVERY write into `POST /admin/$batch` — Akamai
  // allows POST. Hand-rolled `fetch(url, { method: "PATCH" })` calls in the
  // admin controllers do NOT batch, so they 501 on PROD (CREATE via POST works,
  // UPDATE via PATCH does not). Routing those writes through this helper makes
  // them behave like the FE model and pass the edge.
  //
  // This module is resolvable from every admin sub-app because the admin-shell
  // registers `sap.tutorials.admin.shell` → `./` at bootstrap (index.html), and
  // the shell is always the host component. Require it as
  //   "sap/tutorials/admin/shell/lib/odata-batch"
  //
  // Zero-dependency `sap.ui.define([], …)` so it is unit-testable in Node via a
  // `sap.ui.define` stub (see test/unit/odata-batch.test.js), matching the
  // puzzle draft-save test pattern.
  // ──────────────────────────────────────────────────────────────────────────

  // Build a fetch-Response-like object from a status + (parsed or string) body,
  // so call sites keep their existing `.then(res => res.ok ? … : throw)` shape.
  function makeResponseLike(status, body) {
    var isString = typeof body === "string";
    return {
      ok: status >= 200 && status < 300,
      status: status,
      json: function () {
        if (isString) { return Promise.resolve(body ? JSON.parse(body) : null); }
        return Promise.resolve(body === undefined ? null : body);
      },
      text: function () {
        if (isString) { return Promise.resolve(body); }
        return Promise.resolve(body === undefined || body === null ? "" : JSON.stringify(body));
      }
    };
  }

  /**
   * Tunnel a single write through POST /<service>$batch (JSON batch).
   *
   * @param {object}   opts
   * @param {function} [opts.fetchFn]  fetch implementation (defaults to global fetch)
   * @param {string}   opts.service    service root WITH trailing slash, e.g. "/admin/"
   * @param {string}   opts.url        entity path RELATIVE to the service root,
   *                                   e.g. "ChatSettings" or
   *                                   "Puzzles(ID=…,IsActiveEntity=false)"
   * @param {string}   [opts.method]   write verb (default "PATCH")
   * @param {object}   opts.headers    request headers incl. x-csrf-token
   * @param {object}   [opts.body]     JS object payload (omit for DELETE);
   *                                   pass the OBJECT, not a JSON string
   * @returns {Promise<object>} Response-like { ok, status, json(), text() }
   *                            describing the INNER (batched) response.
   */
  function batchWrite(opts) {
    var fetchFn = opts.fetchFn || (typeof fetch !== "undefined" ? fetch : null);
    var service = opts.service;
    var method = (opts.method || "PATCH").toUpperCase();
    var srcHeaders = opts.headers || {};
    var hasBody = opts.body !== undefined && opts.body !== null;

    var sub = { id: "r1", method: method, url: opts.url };
    if (hasBody) {
      sub.headers = { "content-type": "application/json" };
      sub.body = opts.body;
    }

    // The outer POST carries the CSRF token and JSON content negotiation.
    var outerHeaders = {};
    Object.keys(srcHeaders).forEach(function (k) { outerHeaders[k] = srcHeaders[k]; });
    outerHeaders["Content-Type"] = "application/json";
    outerHeaders["Accept"] = "application/json";

    return fetchFn(service + "$batch", {
      method: "POST",
      credentials: "include",
      headers: outerHeaders,
      body: JSON.stringify({ requests: [sub] })
    }).then(function (outer) {
      // Outer envelope failed (auth redirect, CSRF, or — unexpectedly — the
      // POST itself blocked). Surface it verbatim so callers can report it.
      if (!outer.ok) {
        return outer.text().then(function (t) { return makeResponseLike(outer.status, t); });
      }
      return outer.json().then(function (payload) {
        var inner = payload && payload.responses && payload.responses[0];
        if (!inner) {
          return makeResponseLike(500,
            "Malformed $batch response: " + JSON.stringify(payload));
        }
        return makeResponseLike(inner.status || 200, inner.body);
      });
    });
  }

  return { batchWrite: batchWrite };
});
