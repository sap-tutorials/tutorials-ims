sap.ui.define([], function () {
  "use strict";

  function parseWordList(text) {
    return String(text || "")
      .split(/[\r\n,;]+/)
      .map(function (w) { return w.toUpperCase().replace(/[^A-Z]/g, ""); })
      .filter(function (w) { return w.length > 0; });
  }

  function countWords(text) { return parseWordList(text).length; }

  function exportPuzzle(state) {
    var grid = (state.grid || []).map(function (row) {
      return row.map(function (cell) {
        return { black: !!cell.black, number: cell.number || null };
      });
    });
    return {
      formatVersion: 1,
      rows: Number(state.rows), cols: Number(state.cols), grid: grid,
      wordText: state.wordText || "",
      clues: state.clues || {}, hints: state.hints || {},
      wordLengths: state.wordLengths || {}, answers: state.answers || {},
      title: state.title || "", slug: state.slug || ""
    };
  }

  function importPuzzle(obj) {
    if (!obj || typeof obj !== "object") { return { ok: false, error: "Not an object" }; }
    // Coerce numeric strings — a puzzle exported after a touched Rows/Cols field
    // can carry "5" instead of 5 (issue #1834).
    var rows = Number(obj.rows), cols = Number(obj.cols);
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
      return { ok: false, error: "rows/cols must be positive integers" };
    }
    if (!Array.isArray(obj.grid) || obj.grid.length !== rows) {
      return { ok: false, error: "grid must have " + rows + " rows" };
    }
    for (var r = 0; r < rows; r++) {
      if (!Array.isArray(obj.grid[r]) || obj.grid[r].length !== cols) {
        return { ok: false, error: "grid row " + r + " must have " + cols + " cells" };
      }
    }
    return {
      ok: true,
      state: {
        rows: rows, cols: cols,
        grid: obj.grid.map(function (row) {
          return row.map(function (cell) {
            return { black: !!(cell && cell.black), letter: "", number: (cell && cell.number) || null };
          });
        }),
        wordText: obj.wordText || "",
        clues: obj.clues || {}, hints: obj.hints || {},
        wordLengths: obj.wordLengths || {}, answers: obj.answers || {},
        title: obj.title || "", slug: obj.slug || ""
      }
    };
  }

  return { parseWordList: parseWordList, countWords: countWords, exportPuzzle: exportPuzzle, importPuzzle: importPuzzle };
});
