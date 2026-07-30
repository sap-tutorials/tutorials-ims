// app/admin/puzzles/webapp/lib/solver-core.js
// Pure backtracking crossword filler with MRV slot ordering.
// No DOM — deterministic and unit-testable. UMD: registers as an anonymous AMD
// module when sap.ui.define exists (Builder controller + vm unit tests), and as
// self.SolverCore when loaded via importScripts inside the classic Web Worker.
// This is the SINGLE source of the solve logic — the worker does NOT copy it.
//
// solve(opts) → { status, grid, placed }
//   status: 'solved' | 'timeout' | 'nosolution'
//   grid:   new 2-D grid with all letters present (pre-filled + solver-added)
//   placed: map "r,c" → LETTER containing ONLY the letters the solver added
//           (pre-seeded cells from opts.grid are excluded)
(function (root, factory) {
  "use strict";
  if (typeof sap !== "undefined" && sap.ui && sap.ui.define) {
    sap.ui.define([], factory);            // AMD (controller + tests)
  } else {
    root.SolverCore = factory();           // worker global (importScripts)
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Read the current letters at a slot's cells from a "r,c"→LETTER map.
  function slotPattern(slot, letters) {
    return slot.cells.map(function (cell) { return letters[cell.r + "," + cell.c] || ""; });
  }

  // True if `word` fits `slot` given already-placed crossing letters.
  function fits(slot, word, letters) {
    if (word.length !== slot.len) { return false; }
    for (var i = 0; i < slot.len; i++) {
      var cell = slot.cells[i];
      var existing = letters[cell.r + "," + cell.c];
      if (existing && existing !== word[i]) { return false; }
    }
    return true;
  }

  function place(slot, word, letters) {
    slot.cells.forEach(function (cell, i) { letters[cell.r + "," + cell.c] = word[i]; });
  }

  // Remove only the letters this placement added (those not in `before`).
  function unplace(slot, letters, before) {
    slot.cells.forEach(function (cell) {
      var key = cell.r + "," + cell.c;
      if (!(key in before)) { delete letters[key]; }
    });
  }

  function countCandidates(slot, words, letters) {
    var n = 0;
    for (var i = 0; i < words.length; i++) { if (fits(slot, words[i], letters)) { n++; } }
    return n;
  }

  // opts.nowFn: monotonic clock. When omitted, a per-attempt counter is used and
  // timeLimitMs is an attempt budget (deterministic for unit tests). The worker
  // passes { nowFn: () => Date.now(), timeLimitMs: <wall-clock ms> } for real time.
  function solve(opts) {
    var slots = opts.slots;
    var words = (opts.words || []).map(function (w) { return String(w).toUpperCase(); });
    var timeLimitMs = opts.timeLimitMs != null ? opts.timeLimitMs : 12000;
    var onProgress = opts.onProgress;
    var counter = 0;
    var nowFn = opts.nowFn || function () { return (counter += 1); };
    var start = nowFn();
    var deadline = start + timeLimitMs;

    // Seed letters from any pre-filled grid cells.
    var letters = {};
    if (opts.grid) {
      for (var r = 0; r < opts.grid.length; r++) {
        for (var c = 0; c < opts.grid[r].length; c++) {
          var cell = opts.grid[r][c];
          if (cell && !cell.black && cell.letter) { letters[r + "," + c] = cell.letter.toUpperCase(); }
        }
      }
    }
    // Capture the set of pre-seeded keys so `placed` can exclude them.
    var seeded = {};
    Object.keys(letters).forEach(function (k) { seeded[k] = true; });

    var used = {};
    var timedOut = false;

    function backtrack() {
      if (nowFn() > deadline) { timedOut = true; return false; }
      // Pick the unfilled slot with the fewest candidates (MRV).
      var target = null, best = Infinity;
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        var pat = slotPattern(s, letters);
        var full = pat.every(function (ch) { return ch; });
        if (full) { continue; }
        var cnt = countCandidates(s, words, letters);
        if (cnt < best) { best = cnt; target = s; if (cnt === 0) { break; } }
      }
      if (!target) { return true; }          // all slots filled → solved
      if (best === 0) { return false; }        // dead end

      for (var w = 0; w < words.length; w++) {
        var word = words[w];
        if (used[word]) { continue; }
        if (!fits(target, word, letters)) { continue; }
        var before = {};
        target.cells.forEach(function (cell) {
          var k = cell.r + "," + cell.c; if (k in letters) { before[k] = letters[k]; }
        });
        place(target, word, letters);
        used[word] = true;
        if (onProgress) { onProgress(Object.assign({}, letters)); }
        if (backtrack()) { return true; }
        unplace(target, letters, before);
        used[word] = false;
        if (timedOut) { return false; }
      }
      return false;
    }

    var ok = backtrack();

    // Rebuild grid with placed letters (never mutate input).
    var outGrid = (opts.grid || []).map(function (row) {
      return row.map(function (cell) { return Object.assign({}, cell); });
    });
    Object.keys(letters).forEach(function (key) {
      var parts = key.split(","); var rr = +parts[0], cc = +parts[1];
      if (outGrid[rr] && outGrid[rr][cc]) { outGrid[rr][cc].letter = letters[key]; }
    });

    var status = ok ? "solved" : (timedOut ? "timeout" : "nosolution");
    // placed = only the letters the solver added; pre-seeded cells are excluded.
    var placed = {};
    Object.keys(letters).forEach(function (k) { if (!seeded[k]) { placed[k] = letters[k]; } });
    return { status: status, grid: outGrid, placed: placed };
  }

  return { solve: solve, fits: fits, slotPattern: slotPattern };
});
