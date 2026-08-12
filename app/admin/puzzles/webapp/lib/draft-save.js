sap.ui.define([], function () {
  "use strict";

  // ──────────────────────────────────────────────────────────────────────────
  // draft-save.js
  //
  // Orchestrates the CAP draft save flow for a puzzle:
  //   CREATE: POST /admin/Puzzles              → draftActivate
  //   UPDATE: draftEdit → PATCH draft           → draftActivate
  //
  // Bug fix (issue #1650 bug 3): on UPDATE, `draftEdit` can return
  //   409 { code: "DRAFT_ALREADY_EXISTS" }
  // when a prior edit session left an un-activated draft (opened the editor and
  // navigated away, or a save failed mid-flight). The old controller treated
  // that as a hard error, so the puzzle could never be re-saved until the stale
  // draft was cleared. A CAP edit-draft shares the active entity's key, so we
  // recover by resuming that existing draft — PATCH it with the fresh fields
  // and activate — instead of failing.
  //
  // Bug fix (issue #1650 reopened): on PROD the draft PATCH was rejected by
  // Akamai with `501 Unsupported Request` (bare PATCH verb blocked at the edge).
  // The PATCH is now tunnelled through `POST /admin/$batch` via the shared
  // `batchWrite` helper (injected as `opts.batchWrite`), exactly as the Fiori
  // OData V4 model batches all its writes. `draftEdit`/`draftActivate` are POST
  // actions and pass the edge unchanged, so they stay direct.
  //
  // `fetchFn` and `batchWrite` are injected so this is unit-testable without a
  // browser.
  // ──────────────────────────────────────────────────────────────────────────

  function jsonOrThrow(step) {
    return function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          throw new Error(step + " HTTP " + r.status + ": " + t);
        });
      }
      return r.json();
    };
  }

  /**
   * @param {object}   opts
   * @param {function} opts.fetchFn     fetch implementation (window.fetch)
   * @param {function} opts.batchWrite  shared odata-batch.batchWrite (tunnels
   *                                    the draft PATCH through POST /admin/$batch
   *                                    so it survives the Akamai edge)
   * @param {object}   opts.headers  request headers (incl. x-csrf-token)
   * @param {string}   [opts.editId] active entity ID when updating; falsy = create
   * @param {object}   opts.fields   the puzzle fields to persist
   * @returns {Promise<object>} the activated (active) entity JSON
   */
  function performPuzzleSave(opts) {
    var fetchFn = opts.fetchFn;
    var batchWrite = opts.batchWrite;
    var headers = opts.headers;
    var editId = opts.editId;
    var fields = opts.fields;

    function patchDraft(draftId) {
      // PATCH via $batch (POST) — a bare PATCH 501s at the Akamai edge on PROD.
      return batchWrite({
        fetchFn: fetchFn,
        service: "/admin/",
        url: "Puzzles(ID=" + draftId + ",IsActiveEntity=false)",
        method: "PATCH",
        headers: headers,
        body: fields
      }).then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) { throw new Error("PATCH draft HTTP " + r.status + ": " + t); });
        }
        return draftId;
      });
    }

    function activate(draftId) {
      return fetchFn(
        "/admin/Puzzles(ID=" + draftId + ",IsActiveEntity=false)/AdminService.draftActivate",
        { method: "POST", credentials: "include", headers: headers, body: "{}" }
      ).then(jsonOrThrow("draftActivate"));
    }

    if (editId) {
      return fetchFn(
        "/admin/Puzzles(ID=" + editId + ",IsActiveEntity=true)/AdminService.draftEdit",
        { method: "POST", credentials: "include", headers: headers, body: "{}" }
      ).then(function (r) {
        if (r.ok) {
          return r.json().then(function (draft) { return (draft && draft.ID) || editId; });
        }
        return r.text().then(function (t) {
          // Resume an orphaned draft rather than failing the save.
          if (r.status === 409 && /DRAFT_ALREADY_EXISTS/.test(t)) {
            return editId; // edit draft shares the active entity's key
          }
          throw new Error("draftEdit HTTP " + r.status + ": " + t);
        });
      }).then(patchDraft).then(activate);
    }

    // CREATE: POST a draft, then activate it. (POST passes the Akamai edge, so
    // no $batch tunnelling is needed here — only PATCH/DELETE are blocked.)
    return fetchFn("/admin/Puzzles", {
      method: "POST", credentials: "include", headers: headers, body: JSON.stringify(fields)
    }).then(jsonOrThrow("POST draft")).then(function (draft) {
      return activate(draft.ID);
    });
  }

  return { performPuzzleSave: performPuzzleSave };
});
