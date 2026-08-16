sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/ui/core/Fragment",
  "sap/tutorials/admin/puzzles/lib/crossword-geometry",
  "sap/tutorials/admin/puzzles/lib/puzzle-io",
  "sap/tutorials/admin/puzzles/lib/solver-core",
  "sap/tutorials/admin/puzzles/lib/draft-save",
  "sap/tutorials/admin/shell/lib/odata-batch"
], function (Controller, JSONModel, MessageToast, MessageBox, Fragment, geom, io, solver, draftSave, odataBatch) {
  "use strict";

  // ──────────────────────────────────────────────────────────────────────────
  // Builder.controller.js
  //
  // Geometry consumption:
  //   crossword-geometry.js is a UI5 AMD module (sap.ui.define) loaded via this
  //   controller's dependency array (the `geom` argument above). It is NOT
  //   loaded via native dynamic import() — the approuter CSP forbids
  //   'unsafe-eval', and import(toUrl(...)) evaluates module source as a string,
  //   which CSP blocks (the failure that made the builder fail to load on DEV).
  //   Being an AMD dependency, `geom` is guaranteed present before any handler
  //   runs, so no async-ready guard is needed.
  // ──────────────────────────────────────────────────────────────────────────

  // Cell size in pixels for the rendered grid
  var CELL_PX = 32;

  // HTML-escape a string before inserting into innerHTML
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  return Controller.extend("sap.tutorials.admin.puzzles.controller.Builder", {

    // ── Lifecycle ────────────────────────────────────────────────────────────

    onInit: function () {
      var oState = new JSONModel({
        mode: "list",
        pageTitle: "Puzzles",
        rows: 15,
        cols: 15,
        grid: [],
        slotsAcross: [],
        slotsDown: [],
        // per-slot maps keyed by slot id
        clues: {},
        hints: {},
        answers: {},
        subMode: "design",   // "design" | "fill"
        title: "",
        slug: "",
        savedSlug: "",
        editId: null,        // OData ID when editing existing puzzle (null = new)
        wordText: "",
        wordCount: 0,
        fillRunning: false,
        fillStatus: "",
        suggestions: []
      });
      this.getView().setModel(oState, "b");
    },

    // ── List mode ────────────────────────────────────────────────────────────

    onCreateNew: function () {
      var b = this.getView().getModel("b");
      var rows = parseInt(b.getProperty("/rows"), 10) || 15;
      var cols = parseInt(b.getProperty("/cols"), 10) || 15;
      var grid = geom.numberGrid(geom.makeEmptyGrid(rows, cols));
      b.setProperty("/grid", grid);
      b.setProperty("/rows", rows);
      b.setProperty("/cols", cols);
      b.setProperty("/title", "");
      b.setProperty("/slug", "");
      b.setProperty("/savedSlug", "");
      b.setProperty("/editId", null);
      b.setProperty("/clues", {});
      b.setProperty("/hints", {});
      b.setProperty("/answers", {});
      b.setProperty("/subMode", "design");
      b.setProperty("/pageTitle", "New Puzzle");
      this._recomputeSlots();
      b.setProperty("/mode", "edit");
      this._scheduleRenderGrid();
    },

    onPuzzlePress: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext();
      if (!oCtx) { return; }
      var self = this;
      // OData V4: the list binding uses autoExpandSelect, so only the visible
      // columns (ID/slug/status/title) are $select'd and cached. requestObject()
      // returns ONLY cached data — it does NOT trigger a back-end request — so
      // layout/solution came back undefined and the builder loaded empty.
      // requestProperty() DOES fetch un-cached properties from the back end;
      // merge them onto the cached row before rebuilding the grid.
      var row = oCtx.getObject() || {};
      oCtx.requestProperty(["layout", "solution"]).then(function (values) {
        self._loadPuzzleForEdit(Object.assign({}, row, {
          layout: values[0],
          solution: values[1]
        }));
      }).catch(function (err) {
        MessageBox.error("Could not open puzzle: " + (err && err.message || err));
      });
    },

    onUnpublish: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext();
      if (!oCtx) { return; }
      var row = oCtx.getObject() || {};
      var id = row.ID;
      if (!id) { return; }
      var self = this;
      MessageBox.confirm("Unpublish this puzzle?", {
        title: "Confirm Unpublish",
        onClose: function (action) {
          if (action !== MessageBox.Action.OK) { return; }
          self._withCsrf(function (token) {
            var headers = {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "x-csrf-token": token
            };
            // draftEdit → PATCH(status:'INACTIVE') → draftActivate
            return fetch(
              "/admin/Puzzles(ID=" + id + ",IsActiveEntity=true)/AdminService.draftEdit",
              { method: "POST", credentials: "include", headers: headers, body: "{}" }
            ).then(function (r) {
              if (!r.ok) { return r.text().then(function (t) { throw new Error("draftEdit HTTP " + r.status + ": " + t); }); }
              return r.json();
            }).then(function (draft) {
              var draftId = draft.ID || id;
              // PATCH via $batch (POST) — a bare PATCH 501s at the Akamai edge on PROD.
              return odataBatch.batchWrite({
                fetchFn: fetch,
                service: "/admin/",
                url: "Puzzles(ID=" + draftId + ",IsActiveEntity=false)",
                method: "PATCH",
                headers: headers,
                body: { status: "INACTIVE" }
              }).then(function (r2) {
                if (!r2.ok) { return r2.text().then(function (t) { throw new Error("PATCH draft HTTP " + r2.status + ": " + t); }); }
                return draftId;
              });
            }).then(function (draftId) {
              return fetch(
                "/admin/Puzzles(ID=" + draftId + ",IsActiveEntity=false)/AdminService.draftActivate",
                { method: "POST", credentials: "include", headers: headers, body: "{}" }
              ).then(function (r3) {
                if (!r3.ok) { return r3.text().then(function (t) { throw new Error("draftActivate HTTP " + r3.status + ": " + t); }); }
                return r3.json();
              });
            });
          }).then(function () {
            MessageToast.show("Puzzle unpublished");
            var oModel = self.getView().getModel();
            if (oModel && oModel.refresh) { oModel.refresh(); }
          }).catch(function (err) {
            MessageBox.error("Unpublish failed: " + (err.message || String(err)));
          });
        }
      });
    },

    _loadPuzzleForEdit: function (row) {
      var b = this.getView().getModel("b");
      // Parse existing layout/solution if present
      var layout = {};
      var solution = {};
      try { if (row.layout) { layout = JSON.parse(row.layout); } } catch (e) { /* ignore */ }
      try { if (row.solution) { solution = JSON.parse(row.solution); } } catch (e) { /* ignore */ }

      var rows = Number(row.rows || layout.rows) || 15;
      var cols = Number(row.cols || layout.cols) || 15;

      // Rebuild grid from layout.grid or make empty
      var grid;
      if (layout.grid && layout.grid.length === rows) {
        // Merge numbers/black; letters come from solution
        grid = layout.grid.map(function (gridRow) {
          return gridRow.map(function (cell) {
            return { black: !!cell.black, letter: "", number: cell.number || null };
          });
        });
        // Stamp letters from solution
        Object.keys(solution).forEach(function (key) {
          var parts = key.split(",");
          var r = parseInt(parts[0], 10);
          var c = parseInt(parts[1], 10);
          if (grid[r] && grid[r][c]) { grid[r][c].letter = solution[key] || ""; }
        });
      } else {
        grid = geom.numberGrid(geom.makeEmptyGrid(rows, cols));
      }

      b.setProperty("/editId", row.ID || null);
      b.setProperty("/title", row.title || "");
      b.setProperty("/slug", row.slug || "");
      b.setProperty("/savedSlug", row.slug || "");
      b.setProperty("/rows", rows);
      b.setProperty("/cols", cols);
      b.setProperty("/grid", grid);
      b.setProperty("/clues", layout.clues || {});
      b.setProperty("/hints", layout.hints || {});
      // Rebuild answers from solution
      b.setProperty("/answers", Object.assign({}, solution));
      b.setProperty("/subMode", "design");
      b.setProperty("/pageTitle", row.title || "Edit Puzzle");
      this._recomputeSlots();
      b.setProperty("/mode", "edit");
      this._scheduleRenderGrid();
    },

    onNavBack: function () {
      var b = this.getView().getModel("b");
      b.setProperty("/mode", "list");
      b.setProperty("/pageTitle", "Puzzles");
    },

    // ── Word list ─────────────────────────────────────────────────────────────

    onWordTextChange: function () {
      var b = this.getView().getModel("b");
      b.setProperty("/wordCount", io.countWords(b.getProperty("/wordText")));
    },

    onUploadWordList: function (oEvent) {
      var file = oEvent.getParameter("files") && oEvent.getParameter("files")[0];
      if (!file) { return; }
      if (file.size > 2 * 1024 * 1024) { MessageToast.show("File too large (max 2 MB)"); return; }
      var b = this.getView().getModel("b");
      var self = this;
      var reader = new FileReader();
      reader.onload = function (e) {
        b.setProperty("/wordText", String(e.target.result || ""));
        self.onWordTextChange();
      };
      reader.onerror = function () { MessageToast.show("Could not read file"); };
      reader.readAsText(file);
    },

    onClearWordList: function () {
      var b = this.getView().getModel("b");
      b.setProperty("/wordText", "");
      b.setProperty("/wordCount", 0);
    },

    // ── Sub-mode toggle ───────────────────────────────────────────────────────

    onSubModeChange: function () {
      this._renderGrid();
    },

    // ── Grid interactions ─────────────────────────────────────────────────────

    onToggleBlack: function (r, c) {
      var b = this.getView().getModel("b");
      var grid = geom.setBlack(b.getProperty("/grid"), r, c);
      grid = geom.numberGrid(grid);
      b.setProperty("/grid", grid);
      this._recomputeSlots();
      this._renderGrid();
    },

    onFocusCell: function (r, c) {
      // Focus tracking for fill mode — highlight active cell + compute suggestions
      this._activeCell = { r: r, c: c };
      this._computeSuggestions(r, c);
      this._renderGrid();
    },

    _computeSuggestions: function (r, c) {
      var b = this.getView().getModel("b");
      var grid = b.getProperty("/grid");
      var slots = geom.findSlots(grid, 2);
      var answers = b.getProperty("/answers") || {};
      // Prefer the across slot containing (r,c); fall back to down.
      var slot = slots.find(function (s) {
        return s.dir === "across" && s.cells.some(function (x) { return x.r === r && x.c === c; });
      }) || slots.find(function (s) {
        return s.cells.some(function (x) { return x.r === r && x.c === c; });
      });
      if (!slot) { b.setProperty("/suggestions", []); return; }
      var words = io.parseWordList(b.getProperty("/wordText"));
      var matches = words.filter(function (w) { return solver.fits(slot, w, answers); }).slice(0, 30);
      this._suggestSlot = slot;
      b.setProperty("/suggestions", matches.map(function (w) { return { word: w }; }));
    },

    onPickSuggestion: function (oEvent) {
      var word = oEvent.getSource().getBindingContext("b").getProperty("word");
      var b = this.getView().getModel("b");
      var answers = Object.assign({}, b.getProperty("/answers"));
      this._suggestSlot.cells.forEach(function (cell, i) { answers[cell.r + "," + cell.c] = word[i]; });
      b.setProperty("/answers", answers);
      this._recomputeSlots();
      this._renderGrid();
    },

    // ── Grid template handlers ────────────────────────────────────────────────

    onSelectGrid: function () {
      var self = this;
      var oModel = this.getView().getModel(); // OData V4 AdminService
      var oList = oModel.bindList("/GridTemplates");
      oList.requestContexts(0, 100).then(function (ctxs) {
        var templates = ctxs.map(function (ctx) { return ctx.getObject(); });
        var gt = new JSONModel({ templates: templates });
        self.getView().setModel(gt, "gt");
        if (!self._gridPickerPromise) {
          self._gridPickerPromise = Fragment.load({
            name: "sap.tutorials.admin.puzzles.view.GridPicker",
            controller: self
          }).then(function (oDialog) {
            self._gridPicker = oDialog;
            self.getView().addDependent(oDialog);
            return oDialog;
          });
        }
        self._gridPickerPromise.then(function (oDialog) {
          oDialog.open();
        });
      }).catch(function (err) {
        MessageBox.error("Could not load grid templates: " + (err && err.message || err));
      });
    },

    onApplyTemplate: function (oEvent) {
      var t = oEvent.getSource().getBindingContext("gt").getObject();
      var b = this.getView().getModel("b");
      var rows = t.rows || b.getProperty("/rows");
      var cols = t.cols || b.getProperty("/cols");
      var grid = geom.makeEmptyGrid(rows, cols);
      (JSON.parse(t.blacks || "[]")).forEach(function (rc) {
        if (grid[rc[0]] && grid[rc[0]][rc[1]]) { grid[rc[0]][rc[1]].black = true; }
      });
      b.setProperty("/rows", rows);
      b.setProperty("/cols", cols);
      b.setProperty("/grid", geom.numberGrid(grid));
      b.setProperty("/answers", {});
      this._recomputeSlots();
      this._renderGrid();
      if (this._gridPicker) { this._gridPicker.close(); }
    },

    onCloseGridPicker: function () { if (this._gridPicker) { this._gridPicker.close(); } },

    onSaveGrid: function () {
      var self = this;
      var b = this.getView().getModel("b");
      var grid = b.getProperty("/grid");
      var blacks = [];
      grid.forEach(function (row, r) { row.forEach(function (cell, c) { if (cell.black) { blacks.push([r, c]); } }); });
      MessageBox.show("Save current grid as a template?", {
        icon: MessageBox.Icon.QUESTION, title: "Save Grid",
        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
        onClose: function (action) {
          if (action !== MessageBox.Action.OK) { return; }
          var fields = {
            name: (b.getProperty("/title") || "Grid") + " layout",
            rows: b.getProperty("/rows"),
            cols: b.getProperty("/cols"),
            blacks: JSON.stringify(blacks),
            isBuiltin: false
          };
          self._withCsrf(function (token) {
            var headers = { "Content-Type": "application/json", "Accept": "application/json", "x-csrf-token": token };
            return fetch("/admin/GridTemplates", {
              method: "POST", credentials: "include", headers: headers, body: JSON.stringify(fields)
            }).then(function (r) {
              if (!r.ok) { return r.text().then(function (t) { throw new Error("POST " + r.status + ": " + t); }); }
              return r.json();
            }).then(function (draft) {
              return fetch(
                "/admin/GridTemplates(ID=" + draft.ID + ",IsActiveEntity=false)/AdminService.draftActivate",
                { method: "POST", credentials: "include", headers: headers, body: "{}" }
              );
            });
          }).then(function () { MessageToast.show("Grid template saved"); })
            .catch(function (err) { MessageBox.error("Save template failed: " + (err.message || err)); });
        }
      });
    },

    // ── Slot panel event handlers ─────────────────────────────────────────────

    onAnswerChange: function (oEvent) {
      var oInput = oEvent.getSource();
      var oCtx = oInput.getBindingContext("b");
      if (!oCtx) { return; }
      var sId = oCtx.getProperty("id");
      var sVal = (oEvent.getParameter("value") || "").toUpperCase();
      // Update the slot item's answer
      oCtx.getModel().setProperty(oCtx.getPath() + "/answer", sVal);
      // Store in master answers map keyed by slotId
      var b = this.getView().getModel("b");
      var answers = b.getProperty("/answers") || {};
      // Place letters into solution map keyed "r,c"
      // _getAllSlots() returns display items (no .cells); resolve the real geometry
      // slot from the grid so we can iterate its cells.
      var slot = geom.findSlots(b.getProperty("/grid"), 2).find(function (s) { return s.id === sId; });
      if (slot) {
        slot.cells.forEach(function (cell, i) {
          var key = cell.r + "," + cell.c;
          if (sVal[i]) {
            answers[key] = sVal[i];
          } else {
            delete answers[key];
          }
        });
      }
      b.setProperty("/answers", answers);
    },

    onClueChange: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("b");
      if (!oCtx) { return; }
      var sId = oCtx.getProperty("id");
      var sVal = oEvent.getParameter("value") || "";
      oCtx.getModel().setProperty(oCtx.getPath() + "/clue", sVal);
      var b = this.getView().getModel("b");
      var clues = b.getProperty("/clues") || {};
      clues[sId] = sVal;
      b.setProperty("/clues", clues);
    },

    onHintChange: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("b");
      if (!oCtx) { return; }
      var sId = oCtx.getProperty("id");
      var sVal = oEvent.getParameter("selectedItem").getKey();
      oCtx.getModel().setProperty(oCtx.getPath() + "/hint", sVal);
      var b = this.getView().getModel("b");
      var hints = b.getProperty("/hints") || {};
      if (sVal) {
        hints[sId] = sVal;
      } else {
        delete hints[sId];
      }
      b.setProperty("/hints", hints);
    },

    // ── Save ─────────────────────────────────────────────────────────────────
    //
    // AdminService.Puzzles IS @odata.draft.enabled (app/admin-annotations.cds:12).
    // A plain POST creates a draft row (IsActiveEntity=false) — not an active row.
    // The correct two-phase OData V4 draft flow is:
    //
    //   CREATE:
    //     1. POST /admin/Puzzles { ...fields }
    //        → 201  { ID, IsActiveEntity: false, ... }
    //     2. POST /admin/Puzzles(ID=<guid>,IsActiveEntity=false)/AdminService.draftActivate {}
    //        → 201  { ID, IsActiveEntity: true, ... }
    //
    //   UPDATE (existing active row):
    //     1. POST /admin/Puzzles(ID=<guid>,IsActiveEntity=true)/AdminService.draftEdit {}
    //        → 200  { ID, IsActiveEntity: false, ... }  (creates edit draft)
    //     2. PATCH /admin/Puzzles(ID=<guid>,IsActiveEntity=false) { ...fields }
    //        → 200
    //     3. POST /admin/Puzzles(ID=<guid>,IsActiveEntity=false)/AdminService.draftActivate {}
    //        → 200  { ID, IsActiveEntity: true, ... }
    //
    // Pattern confirmed in: test/admin-drafts.test.js:103-108,
    //   test/admin-slug-derivation.test.js:47-53,
    //   test/published-flag.test.js:99-113.

    onSave: function () {
      var self = this;
      var b = this.getView().getModel("b");
      var title = b.getProperty("/title");
      var slug = (b.getProperty("/slug") || "").toLowerCase().replace(/\s+/g, "-");
      if (!title || !slug) {
        MessageBox.error("Title and Slug are required.");
        return;
      }

      var grid = b.getProperty("/grid");
      // Derive rows/cols from the grid itself (ground truth) rather than the
      // model props: the Rows/Cols Number inputs are two-way bound with no type,
      // so a touched field leaves a string in the model. Serialising that string
      // made the server report "grid row count != rows" (issue #1834).
      var rows = grid.length;
      var cols = grid[0] ? grid[0].length : 0;
      var clues = b.getProperty("/clues") || {};
      var hints = b.getProperty("/hints") || {};
      var answers = b.getProperty("/answers") || {};

      // Build layout grid: strip letters, keep black + number
      var layoutGrid = grid.map(function (gridRow) {
        return gridRow.map(function (cell) {
          return { black: !!cell.black, number: cell.number || null };
        });
      });

      // Compute wordLengths per slot
      var wordLengths = {};
      this._getAllSlots().forEach(function (slot) {
        wordLengths[slot.id] = slot.len;
      });

      var layout = JSON.stringify({
        rows: rows,
        cols: cols,
        grid: layoutGrid,
        clues: clues,
        wordLengths: wordLengths,
        hints: hints
      });
      var solution = JSON.stringify(answers);

      var fields = {
        title: title,
        slug: slug,
        status: "ACTIVE",
        layout: layout,
        solution: solution
      };

      var editId = b.getProperty("/editId");

      this._withCsrf(function (token) {
        var headers = {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "x-csrf-token": token
        };
        // Draft orchestration (create vs. update, incl. recovery from an
        // orphaned edit draft that returns 409 DRAFT_ALREADY_EXISTS — issue
        // #1650 bug 3) lives in the unit-tested lib/draft-save module.
        return draftSave.performPuzzleSave({
          fetchFn: fetch,
          batchWrite: odataBatch.batchWrite,
          headers: headers,
          editId: editId,
          fields: fields
        });
      }).then(function (active) {
        var savedSlug = (active && active.slug) || slug;
        var savedId = (active && active.ID) || editId;
        b.setProperty("/savedSlug", savedSlug);
        b.setProperty("/editId", savedId);
        MessageToast.show("Puzzle saved. Slug: " + savedSlug);
        // Refresh the OData list binding
        var oModel = self.getView().getModel();
        if (oModel && oModel.refresh) { oModel.refresh(); }
      }).catch(function (err) {
        MessageBox.error("Save failed: " + (err.message || String(err)));
      });
    },

    onCopyUrl: function () {
      var slug = this.getView().getModel("b").getProperty("/savedSlug");
      var url = window.location.origin + "/puzzles/" + slug;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () {
          MessageToast.show("URL copied to clipboard");
        }).catch(function () {
          MessageToast.show("Copy failed — URL: " + url);
        });
      } else {
        MessageToast.show("URL: " + url);
      }
    },

    // ── Toolbar handlers ─────────────────────────────────────────────────────

    onClearGrid: function () {
      var b = this.getView().getModel("b");
      var rows = parseInt(b.getProperty("/rows"), 10) || 15;
      var cols = parseInt(b.getProperty("/cols"), 10) || 15;
      b.setProperty("/grid", geom.numberGrid(geom.makeEmptyGrid(rows, cols)));
      b.setProperty("/answers", {});
      this._recomputeSlots();
      this._renderGrid();
    },

    // Resize the grid when the Rows/Cols inputs change. Without this the fields
    // were two-way bound with no type, so editing them left a string in the
    // model, did not rebuild the grid, and corrupted the saved layout
    // (issue #1834). Rebuild a fresh empty grid and keep the model props numeric.
    onGridSizeChange: function () {
      var b = this.getView().getModel("b");
      var rows = parseInt(b.getProperty("/rows"), 10);
      var cols = parseInt(b.getProperty("/cols"), 10);
      if (!(rows >= 1)) { rows = 1; } else if (rows > 30) { rows = 30; }
      if (!(cols >= 1)) { cols = 1; } else if (cols > 30) { cols = 30; }
      b.setProperty("/rows", rows);
      b.setProperty("/cols", cols);
      b.setProperty("/grid", geom.numberGrid(geom.makeEmptyGrid(rows, cols)));
      b.setProperty("/answers", {});
      this._recomputeSlots();
      this._renderGrid();
    },

    onClearWords: function () {
      var b = this.getView().getModel("b");
      b.setProperty("/answers", {});
      this._recomputeSlots();
      this._renderGrid();
    },

    onExport: function () {
      var b = this.getView().getModel("b");
      var wordLengths = {};
      this._getAllSlots().forEach(function (s) { wordLengths[s.id] = s.len; });
      var obj = io.exportPuzzle({
        rows: b.getProperty("/rows"), cols: b.getProperty("/cols"),
        grid: b.getProperty("/grid"), wordText: b.getProperty("/wordText"),
        clues: b.getProperty("/clues"), hints: b.getProperty("/hints"),
        wordLengths: wordLengths, answers: b.getProperty("/answers"),
        title: b.getProperty("/title"), slug: b.getProperty("/slug")
      });
      var blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = (b.getProperty("/slug") || "puzzle") + ".json";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },

    onImportPress: function () {
      var input = this._importInput();
      if (input) { input.value = ""; input.click(); }
    },

    // Resolve the hidden native <input type=file> behind the core:HTML control.
    // sap.ui.core.HTML with a single root element assigns the control id to that
    // element, so getDomRef() returns the <input> itself — a querySelector("input")
    // on it finds nothing and the Import button did nothing (issue #1834). Handle
    // both shapes (input is the root, or a descendant) so wiring is robust.
    _importInput: function () {
      var host = this.byId("importFileInput");
      var dom = host && host.getDomRef();
      if (!dom) { return null; }
      if (dom.tagName === "INPUT") { return dom; }
      return dom.querySelector("input");
    },

    onImportFile: function (oEvent) {
      var file = oEvent.target.files && oEvent.target.files[0];
      if (!file) { return; }
      var self = this;
      var reader = new FileReader();
      reader.onload = function (e) {
        var parsed;
        try { parsed = JSON.parse(e.target.result); }
        catch (err) { MessageBox.error("Not valid JSON: " + err.message); return; }
        var res = io.importPuzzle(parsed);
        if (!res.ok) { MessageBox.error("Import failed: " + res.error); return; }
        var b = self.getView().getModel("b");
        var s = res.state;
        b.setProperty("/rows", s.rows); b.setProperty("/cols", s.cols);
        b.setProperty("/grid", geom.numberGrid(s.grid));
        b.setProperty("/wordText", s.wordText);
        b.setProperty("/wordCount", io.countWords(s.wordText));
        b.setProperty("/clues", s.clues); b.setProperty("/hints", s.hints);
        b.setProperty("/answers", s.answers);
        b.setProperty("/title", s.title); b.setProperty("/slug", s.slug);
        self._recomputeSlots(); self._renderGrid();
        MessageToast.show("Puzzle imported");
      };
      reader.readAsText(file);
    },

    onPrint: function () { window.print(); },

    onHelp: function () {
      MessageBox.information(
        "Design mode: click a cell to toggle black (mirrored 180°).\n" +
        "Fill mode: click a cell, then type letters; arrows navigate, Backspace clears.\n" +
        "Word list: paste or upload candidate words. Fill Grid auto-solves from your list; " +
        "Just Fill uses a common-English dictionary.\n" +
        "Suggestions appear beside the focused slot — click one to place it.\n" +
        "Select Grid loads a saved black-square template; Save Grid stores the current one.\n" +
        "Import/Export move puzzles as JSON; Print produces a printable grid + clues.",
        { title: "Puzzle Builder Help" });
    },

    onAfterRendering: function () {
      var self = this;
      var input = this._importInput();
      if (input && !input._wired) {
        input._wired = true;
        input.addEventListener("change", function (e) { self.onImportFile(e); });
      }
    },

    // ── Internal helpers ──────────────────────────────────────────────────────

    _getAllSlots: function () {
      var b = this.getView().getModel("b");
      return (b.getProperty("/slotsAcross") || []).concat(b.getProperty("/slotsDown") || []);
    },

    _recomputeSlots: function () {
      var b = this.getView().getModel("b");
      var grid = b.getProperty("/grid");
      var clues = b.getProperty("/clues") || {};
      var hints = b.getProperty("/hints") || {};
      var answers = b.getProperty("/answers") || {};

      var allSlots = geom.findSlots(grid, 2);

      // Helper: derive label (number of starting cell)
      var across = [];
      var down = [];
      allSlots.forEach(function (slot) {
        // label = the grid number at the slot's first cell
        var firstCell = slot.cells[0];
        var num = (grid[firstCell.r] && grid[firstCell.r][firstCell.c])
          ? grid[firstCell.r][firstCell.c].number
          : null;
        var label = num ? String(num) : slot.id;

        // Reconstruct answer from answers map (keyed "r,c")
        var answer = slot.cells.map(function (cell) {
          return answers[cell.r + "," + cell.c] || "";
        }).join("").replace(/\s/g, "");
        // If all letters present, that's the answer; otherwise empty
        var fullAnswer = answer.length === slot.len ? answer : "";

        var item = {
          id: slot.id,
          dir: slot.dir,
          label: label,
          len: slot.len,
          clue: clues[slot.id] || "",
          hint: hints[slot.id] || "",
          answer: fullAnswer
        };
        if (slot.dir === "across") {
          across.push(item);
        } else {
          down.push(item);
        }
      });

      b.setProperty("/slotsAcross", across);
      b.setProperty("/slotsDown", down);
    },

    _scheduleRenderGrid: function () {
      // Defer one tick so the HTML control has been placed into the DOM
      var self = this;
      setTimeout(function () { self._renderGrid(); }, 0);
    },

    _renderGrid: function () {
      var b = this.getView().getModel("b");
      var grid = b.getProperty("/grid");
      if (!grid || !grid.length) { return; }

      var rows = grid.length;
      var cols = grid[0].length;
      var subMode = b.getProperty("/subMode");
      var answers = b.getProperty("/answers") || {};
      var activeCell = this._activeCell;

      // Find the HTML control's DOM node
      var oHtml = this.byId("gridHost");
      if (!oHtml) { return; }
      var oDom = oHtml.getDomRef();
      if (!oDom) { return; }

      // Build an HTML table — lightweight, no UI5 overhead, fast to rebuild
      var self = this;
      var lines = [
        '<table style="border-collapse:collapse;cursor:pointer;" role="grid" aria-label="Crossword grid">'
      ];

      for (var r = 0; r < rows; r++) {
        lines.push("<tr>");
        for (var c = 0; c < cols; c++) {
          var cell = grid[r][c];
          var isBlack = cell.black;
          var num = cell.number;
          var letter = answers[r + "," + c] || cell.letter || "";
          var isActive = activeCell && activeCell.r === r && activeCell.c === c;

          var bg = isBlack ? "#222" : isActive ? "#d0e8ff" : "#fff";
          var style = [
            "width:" + CELL_PX + "px",
            "height:" + CELL_PX + "px",
            "min-width:" + CELL_PX + "px",
            "border:1px solid #999",
            "position:relative",
            "background:" + bg,
            "text-align:center",
            "vertical-align:middle",
            "user-select:none",
            "padding:0"
          ].join(";");

          var dataAttrs = 'data-r="' + r + '" data-c="' + c + '"';

          if (isBlack) {
            lines.push('<td style="' + style + '" ' + dataAttrs + '></td>');
          } else {
            var inner = "";
            if (num) {
              inner += '<span style="position:absolute;top:1px;left:2px;font-size:9px;line-height:1;color:#444;">' + esc(num) + "</span>";
            }
            if (letter) {
              inner += '<span style="font-size:14px;font-weight:bold;color:#1a1a1a;line-height:' + CELL_PX + 'px;">' + esc(letter) + "</span>";
            }
            lines.push('<td style="' + style + '" ' + dataAttrs + ">" + inner + "</td>");
          }
        }
        lines.push("</tr>");
      }
      lines.push("</table>");

      oDom.innerHTML = lines.join("");

      // Attach click handler to the table (event delegation)
      var oTable = oDom.querySelector("table");
      if (oTable) {
        oTable.addEventListener("click", function (e) {
          var td = e.target.closest("td");
          if (!td) { return; }
          var rr = parseInt(td.getAttribute("data-r"), 10);
          var cc = parseInt(td.getAttribute("data-c"), 10);
          if (isNaN(rr) || isNaN(cc)) { return; }
          var currentGrid = b.getProperty("/grid");
          if (currentGrid[rr][cc].black && subMode === "fill") { return; }
          if (subMode === "design") {
            self.onToggleBlack(rr, cc);
          } else {
            self.onFocusCell(rr, cc);
          }
        });

        // Keyboard handler for fill mode — type letters into focused cell
        if (subMode === "fill") {
          oTable.setAttribute("tabindex", "0");
          oTable.addEventListener("keydown", function (e) {
            var ac = self._activeCell;
            if (!ac) { return; }
            var key = e.key;
            if (key === "Backspace" || key === "Delete") {
              var ans = b.getProperty("/answers") || {};
              delete ans[ac.r + "," + ac.c];
              b.setProperty("/answers", ans);
              self._recomputeSlots();
              self._renderGrid();
              e.preventDefault();
              return;
            }
            if (key.length === 1 && /[a-zA-Z]/.test(key)) {
              var ans2 = b.getProperty("/answers") || {};
              ans2[ac.r + "," + ac.c] = key.toUpperCase();
              b.setProperty("/answers", ans2);
              // Advance one cell to the right (or down) — simple horizontal advance
              var curGrid = b.getProperty("/grid");
              var nc = ac.c + 1;
              if (nc < cols && curGrid[ac.r] && !curGrid[ac.r][nc].black) {
                self._activeCell = { r: ac.r, c: nc };
              }
              self._recomputeSlots();
              self._renderGrid();
              e.preventDefault();
            }
            // Arrow key navigation
            var moves = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
            if (moves[key]) {
              var dr = moves[key][0], dc = moves[key][1];
              var nr = ac.r + dr, nc2 = ac.c + dc;
              var navGrid = b.getProperty("/grid");
              if (nr >= 0 && nr < rows && nc2 >= 0 && nc2 < cols && !navGrid[nr][nc2].black) {
                self._activeCell = { r: nr, c: nc2 };
                self._renderGrid();
              }
              e.preventDefault();
            }
          });
          oTable.focus();
        }
      }
    },

    // ── Auto-fill ─────────────────────────────────────────────────────────────

    onFillGrid: function () { this._runFill("wordlist"); },
    onJustFill: function () { this._runFill("dictionary"); },
    onStopFill: function () {
      if (this._fillWorker) { this._fillWorker.terminate(); this._fillWorker = null; }
      var b = this.getView().getModel("b");
      b.setProperty("/fillRunning", false);
      b.setProperty("/fillStatus", "Stopped");
    },

    _runFill: function (mode) {
      var self = this;
      var b = this.getView().getModel("b");
      var allSlots = geom.findSlots(b.getProperty("/grid"), 2);
      var slots = allSlots.map(function (s) {
        return { id: s.id, dir: s.dir, len: s.len, cells: s.cells };
      });
      var timeLimitMs = mode === "dictionary" ? 30000 : 12000;
      var gridSnapshot = b.getProperty("/grid");

      var proceed = function (words) {
        b.setProperty("/fillRunning", true);
        b.setProperty("/fillStatus", "Solving…");
        var opts = {
          slots: slots, words: words, grid: gridSnapshot,
          rows: b.getProperty("/rows"), cols: b.getProperty("/cols"),
          timeLimitMs: timeLimitMs
        };
        try {
          var url = sap.ui.require.toUrl("sap/tutorials/admin/puzzles/lib/fill-worker.js");
          var worker = new Worker(url);              // classic same-origin worker
          self._fillWorker = worker;
          worker.onmessage = function (ev) {
            var m = ev.data;
            if (m.type === "progress") { self._applyFillResult(m.placed, true); }
            else if (m.type === "result") { self._finishFill(m.status, m.placed); worker.terminate(); }
            else if (m.type === "error") { self._finishFill("error", null); worker.terminate(); }
          };
          worker.onerror = function () {             // CSP or load failure → fallback
            worker.terminate(); self._fillWorker = null; self._fallbackSolveMainThread(opts);
          };
          worker.postMessage(Object.assign({ type: "start" }, opts));
        } catch (e) {
          self._fallbackSolveMainThread(opts);       // Worker ctor blocked → fallback
        }
      };

      if (mode === "dictionary") {
        fetch(sap.ui.require.toUrl("sap/tutorials/admin/puzzles/assets/common-english.txt"))
          .then(function (r) { return r.text(); })
          .then(function (t) { proceed(io.parseWordList(t)); })
          .catch(function () { MessageToast.show("Could not load dictionary"); });
      } else {
        proceed(io.parseWordList(b.getProperty("/wordText")));
      }
    },

    _fallbackSolveMainThread: function (opts) {
      // Worker unavailable/CSP-blocked → solve on the main thread using the same
      // solver-core AMD dep (`solver`). Synchronous; acceptable for the fallback path.
      var res = solver.solve(opts);
      this._finishFill(res.status, res.placed);
    },

    _applyFillResult: function (placed, isProgress) {
      var b = this.getView().getModel("b");
      var answers = Object.assign({}, b.getProperty("/answers"), placed);
      b.setProperty("/answers", answers);
      this._renderGrid();
      if (!isProgress) { this._recomputeSlots(); }
    },

    _finishFill: function (status, placed) {
      var b = this.getView().getModel("b");
      b.setProperty("/fillRunning", false);
      if (status === "solved" || status === "partial") {
        if (placed) { this._applyFillResult(placed, false); }
        b.setProperty("/fillStatus", status === "solved" ? "Solved" : "Partially filled");
      } else if (status === "timeout") {
        b.setProperty("/fillStatus", "Timed out — no complete fill");
      } else if (status === "nosolution") {
        b.setProperty("/fillStatus", "No solution from this word list");
      } else {
        b.setProperty("/fillStatus", "Fill error");
      }
      this._fillWorker = null;
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
