// app/admin/puzzles/webapp/lib/crossword-geometry.js
// Pure, framework-agnostic crossword grid geometry.
// Ported from the POC src/crossword.js pure functions.
// Slot ids: `${row}-${startCol}-across` / `${startRow}-${col}-down`
//
// Authored as a UI5 AMD module (sap.ui.define) so the Builder controller can
// load it via its dependency array — NO native dynamic import(). The approuter
// CSP forbids 'unsafe-eval', and import(toUrl(...)) evaluates module source as a
// string, which CSP blocks. The functions are pure, so the module has an empty
// dependency array. Unit-tested in test/unit/crossword-geometry.test.js via a
// stubbed sap.ui.define + vm sandbox (same pattern as
// test/unit/admin-shell/cron-timeline-helpers.test.js).
sap.ui.define([], function () {
  "use strict";

  /**
   * Create an empty grid of white cells.
   * Each cell: { black: false, letter: '', number: null }
   */
  function makeEmptyGrid(rows, cols) {
    return Array.from({ length: rows }, function () {
      return Array.from({ length: cols }, function () {
        return { black: false, letter: "", number: null };
      });
    });
  }

  /**
   * Toggle cell (r, c) black/white and mirror the same state 180°
   * (rows-1-r, cols-1-c). Returns a new grid (immutable).
   */
  function setBlack(grid, r, c) {
    var rows = grid.length;
    var cols = grid[0] ? grid[0].length : 0;
    var g = grid.map(function (row) { return row.map(function (cell) { return Object.assign({}, cell); }); });
    var next = !g[r][c].black;
    g[r][c].black = next;
    g[rows - 1 - r][cols - 1 - c].black = next;
    return g;
  }

  /**
   * Find all slots (across + down runs) of length >= minLen.
   * Returns array of { id, dir, row, col, len, cells:[{r,c}] }
   */
  function findSlots(grid, minLen) {
    if (minLen === undefined) { minLen = 2; }
    var ROWS = grid.length;
    var COLS = grid[0] ? grid[0].length : 0;
    var slots = [];

    // Across
    for (var r = 0; r < ROWS; r++) {
      var c = 0;
      while (c < COLS) {
        if (grid[r][c].black) { c++; continue; }
        var startC = c;
        while (c < COLS && !grid[r][c].black) { c++; }
        var lenA = c - startC;
        if (lenA >= minLen) {
          var cellsA = Array.from({ length: lenA }, (function (rowIdx, s) {
            return function (_, i) { return { r: rowIdx, c: s + i }; };
          })(r, startC));
          slots.push({ id: r + "-" + startC + "-across", dir: "across", row: r, col: startC, len: lenA, cells: cellsA });
        }
      }
    }

    // Down
    for (var cc = 0; cc < COLS; cc++) {
      var rr = 0;
      while (rr < ROWS) {
        if (grid[rr][cc].black) { rr++; continue; }
        var startR = rr;
        while (rr < ROWS && !grid[rr][cc].black) { rr++; }
        var lenD = rr - startR;
        if (lenD >= minLen) {
          var cellsD = Array.from({ length: lenD }, (function (colIdx, s) {
            return function (_, i) { return { r: s + i, c: colIdx }; };
          })(cc, startR));
          slots.push({ id: startR + "-" + cc + "-down", dir: "down", row: startR, col: cc, len: lenD, cells: cellsD });
        }
      }
    }

    return slots;
  }

  /**
   * Assign sequential numbers to cells that start across or down words.
   * Numbers are assigned left-to-right, top-to-bottom.
   * Returns a new grid with `.number` set on qualifying cells.
   */
  function numberGrid(grid, minLen) {
    if (minLen === undefined) { minLen = 2; }
    var ROWS = grid.length;
    var COLS = grid[0] ? grid[0].length : 0;
    var g = grid.map(function (row) { return row.map(function (cell) { return Object.assign({}, cell, { number: null }); }); });

    var runLen = function (r, c, dr, dc) {
      var len = 0, rr = r, cc = c;
      while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && !g[rr][cc].black) {
        len++; rr += dr; cc += dc;
      }
      return len;
    };

    var startsAcross = function (r, c) {
      return !g[r][c].black &&
        (c === 0 || g[r][c - 1].black) &&
        runLen(r, c, 0, 1) >= minLen;
    };

    var startsDown = function (r, c) {
      return !g[r][c].black &&
        (r === 0 || g[r - 1][c].black) &&
        runLen(r, c, 1, 0) >= minLen;
    };

    var n = 1;
    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        if (startsAcross(r, c) || startsDown(r, c)) {
          g[r][c].number = n++;
        }
      }
    }
    return g;
  }

  /**
   * True if every cell in the slot has a non-empty letter.
   */
  function slotFilled(grid, slot) {
    return slot.cells.every(function (cell) { return !!grid[cell.r][cell.c].letter; });
  }

  /**
   * True if any cell in this slot is shared with a slot in a different direction.
   */
  function slotHasCrossing(slot, allSlots) {
    var others = allSlots.filter(function (s) { return s.id !== slot.id; });
    return slot.cells.some(function (cell) {
      return others.some(function (s) {
        return s.cells.some(function (oc) { return oc.r === cell.r && oc.c === cell.c; });
      });
    });
  }

  /**
   * Place word letters into slot cells. Returns a new grid.
   */
  function placeWord(grid, slot, word) {
    var g = grid.map(function (row) { return row.map(function (cell) { return Object.assign({}, cell); }); });
    slot.cells.forEach(function (cell, i) {
      g[cell.r][cell.c].letter = (word[i] || "").toUpperCase();
    });
    return g;
  }

  /**
   * Clear letters from slot cells. Returns a new grid.
   */
  function removeWord(grid, slot) {
    var g = grid.map(function (row) { return row.map(function (cell) { return Object.assign({}, cell); }); });
    slot.cells.forEach(function (cell) { g[cell.r][cell.c].letter = ""; });
    return g;
  }

  /**
   * True if word length matches slot length and no existing letter conflicts.
   */
  function canFit(grid, slot, word) {
    if (word.length !== slot.len) { return false; }
    return slot.cells.every(function (cell, i) {
      var existing = grid[cell.r][cell.c].letter;
      return !existing || existing === word[i].toUpperCase();
    });
  }

  return {
    makeEmptyGrid: makeEmptyGrid,
    setBlack: setBlack,
    findSlots: findSlots,
    numberGrid: numberGrid,
    slotFilled: slotFilled,
    slotHasCrossing: slotHasCrossing,
    placeWord: placeWord,
    removeWord: removeWord,
    canFit: canFit
  };
});
