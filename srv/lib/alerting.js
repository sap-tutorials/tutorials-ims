// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('./_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/alerting.js'); }
export const raise = mod.raise;
export const raiseTest = mod.raiseTest;
export const _resetForTest = mod._resetForTest;
