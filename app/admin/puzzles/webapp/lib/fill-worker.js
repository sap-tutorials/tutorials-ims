// app/admin/puzzles/webapp/lib/fill-worker.js
// Classic Web Worker — loaded via new Worker(sap.ui.require.toUrl(...)).
// It importScripts the single-source solver-core.js (UMD → self.SolverCore).
// There is NO copy of the solve logic here; solver-core is the one source, unit-tested.
"use strict";
importScripts("./solver-core.js");   // relative to this worker file; same webapp/lib dir

self.onmessage = function (ev) {
  var msg = ev.data;
  if (!msg || msg.type !== "start") { return; }
  try {
    var last = 0;
    var res = self.SolverCore.solve({
      slots: msg.slots, words: msg.words, grid: msg.grid,
      rows: msg.rows, cols: msg.cols,
      timeLimitMs: msg.timeLimitMs,
      nowFn: function () { return Date.now(); },     // real wall-clock budget
      onProgress: function (placed) {
        var now = Date.now();
        if (now - last >= 200) { last = now; self.postMessage({ type: "progress", placed: placed }); }
      }
    });
    self.postMessage({ type: "result", status: res.status, placed: res.placed });
  } catch (e) {
    self.postMessage({ type: "error", message: String(e && e.message || e) });
  }
};
