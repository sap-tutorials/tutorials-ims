// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/alerting.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const raise = mod.raise;
export const raiseTest = mod.raiseTest;
export const _resetForTest = mod._resetForTest;
