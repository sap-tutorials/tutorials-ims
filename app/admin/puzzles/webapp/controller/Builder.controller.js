sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, MessageToast, MessageBox) {
  "use strict";

  // ──────────────────────────────────────────────────────────────────────────
  // Builder.controller.js
  //
  // ESM geometry consumption:
  //   crossword-geometry.js is a plain-ESM module (export function …).
  //   The UI5 AMD loader cannot sap.ui.define-require it.
  //   Strategy: load it once in onInit via native dynamic import() using the
  //   URL resolved by sap.ui.require.toUrl() — this works in UI5 1.120+ where
  //   the UI5 bootstrap does NOT intercept native import() for non-AMD modules.
  //   The module URL is under the registered resource root for the component,
  //   so it resolves to the correct dist/components/puzzles/lib/… path.
  //   Fallback: if import() rejects, the controller posts a MessageBox and
  //   disables editing. The plain-ESM original is kept for vitest consumption.
  // ──────────────────────────────────────────────────────────────────────────

  var GEOM_MODULE_NAME = "sap/tutorials/admin/puzzles/lib/crossword-geometry.js";

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
        editId: null         // OData ID when editing existing puzzle (null = new)
      });
      this.getView().setModel(oState, "b");
      this._geom = null;     // loaded async below

      var sUrl = sap.ui.require.toUrl(GEOM_MODULE_NAME);
      var self = this;
      import(sUrl).then(function (mod) {
        self._geom = mod;
      }).catch(function (err) {
        MessageBox.error(
          "Could not load grid geometry module.\nEditing is disabled until reload.\n\n" + err,
          { title: "Module load error" }
        );
      });
    },

    // ── List mode ────────────────────────────────────────────────────────────

    onCreateNew: function () {
      if (!this._geom) { MessageToast.show("Geometry module not ready. Please wait."); return; }
      var b = this.getView().getModel("b");
      var rows = parseInt(b.getProperty("/rows"), 10) || 15;
      var cols = parseInt(b.getProperty("/cols"), 10) || 15;
      var grid = this._geom.numberGrid(this._geom.makeEmptyGrid(rows, cols));
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
      if (!this._geom) { MessageToast.show("Geometry module not ready. Please wait."); return; }
      var oCtx = oEvent.getSource().getBindingContext();
      if (!oCtx) { return; }
      var row = oCtx.getObject({
        select: "ID,title,slug,status,rows,cols,layout,solution"
      });
      this._loadPuzzleForEdit(row);
    },

    _loadPuzzleForEdit: function (row) {
      var b = this.getView().getModel("b");
      // Parse existing layout/solution if present
      var layout = {};
      var solution = {};
      try { if (row.layout) { layout = JSON.parse(row.layout); } } catch (e) { /* ignore */ }
      try { if (row.solution) { solution = JSON.parse(row.solution); } } catch (e) { /* ignore */ }

      var rows = row.rows || (layout.rows) || 15;
      var cols = row.cols || (layout.cols) || 15;

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
        grid = this._geom.numberGrid(this._geom.makeEmptyGrid(rows, cols));
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

    // ── Sub-mode toggle ───────────────────────────────────────────────────────

    onSubModeChange: function () {
      this._renderGrid();
    },

    // ── Grid interactions ─────────────────────────────────────────────────────

    onToggleBlack: function (r, c) {
      if (!this._geom) { return; }
      var b = this.getView().getModel("b");
      var grid = this._geom.setBlack(b.getProperty("/grid"), r, c);
      grid = this._geom.numberGrid(grid);
      b.setProperty("/grid", grid);
      this._recomputeSlots();
      this._renderGrid();
    },

    onFocusCell: function (r, c) {
      // Focus tracking for fill mode — highlight active cell
      this._activeCell = { r: r, c: c };
      this._renderGrid();
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
      var slots = this._getAllSlots();
      var slot = slots.find(function (s) { return s.id === sId; });
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
      var rows = b.getProperty("/rows");
      var cols = b.getProperty("/cols");
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

      var editId = b.getProperty("/editId");

      this._withCsrf(function (token) {
        if (editId) {
          // Update existing
          return fetch("/admin/Puzzles(" + editId + ")", {
            method: "PATCH",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "x-csrf-token": token
            },
            body: JSON.stringify({
              title: title,
              slug: slug,
              rows: rows,
              cols: cols,
              layout: layout,
              solution: solution
            })
          });
        }
        // Create new (non-draft for simplicity — AdminService.Puzzles
        // @odata.draft.enabled requires two-phase; use plain POST to bypass)
        return fetch("/admin/Puzzles", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-csrf-token": token
          },
          body: JSON.stringify({
            title: title,
            slug: slug,
            status: "DRAFT",
            rows: rows,
            cols: cols,
            layout: layout,
            solution: solution
          })
        });
      }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            throw new Error("HTTP " + res.status + ": " + t);
          });
        }
        return res.json();
      }).then(function (saved) {
        var savedSlug = saved.slug || slug;
        b.setProperty("/savedSlug", savedSlug);
        b.setProperty("/editId", saved.ID || editId);
        MessageToast.show("Puzzle saved. Slug: " + savedSlug);
        // Refresh the OData list model
        var oListBinding = self.getView().getModel().bindList("/Puzzles");
        if (oListBinding && oListBinding.refresh) { oListBinding.refresh(); }
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

    // ── Internal helpers ──────────────────────────────────────────────────────

    _getAllSlots: function () {
      var b = this.getView().getModel("b");
      return (b.getProperty("/slotsAcross") || []).concat(b.getProperty("/slotsDown") || []);
    },

    _recomputeSlots: function () {
      if (!this._geom) { return; }
      var b = this.getView().getModel("b");
      var grid = b.getProperty("/grid");
      var clues = b.getProperty("/clues") || {};
      var hints = b.getProperty("/hints") || {};
      var answers = b.getProperty("/answers") || {};

      var allSlots = this._geom.findSlots(grid, 2);

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
