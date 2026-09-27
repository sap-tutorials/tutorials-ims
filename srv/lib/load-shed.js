// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('./_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/load-shed.js'); }
export const acquireServeSlot = mod.acquireServeSlot;
export const _inFlightForTest = mod._inFlightForTest;
export const _resetForTest = mod._resetForTest;
