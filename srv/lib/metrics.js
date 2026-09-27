// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/metrics.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const counter = mod.counter;
export const gauge = mod.gauge;
export const observe = mod.observe;
export const snapshot = mod.snapshot;
export const rotate = mod.rotate;
export const emitLogLine = mod.emitLogLine;
export const _resetForTest = mod._resetForTest;
