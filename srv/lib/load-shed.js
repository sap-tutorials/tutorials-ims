// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/load-shed.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const acquireServeSlot = mod.acquireServeSlot;
export const _inFlightForTest = mod._inFlightForTest;
export const _resetForTest = mod._resetForTest;
