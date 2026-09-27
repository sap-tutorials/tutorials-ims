// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('./_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/metrics.js'); }
export const counter = mod.counter;
export const gauge = mod.gauge;
export const observe = mod.observe;
export const snapshot = mod.snapshot;
export const rotate = mod.rotate;
export const emitLogLine = mod.emitLogLine;
export const _resetForTest = mod._resetForTest;
