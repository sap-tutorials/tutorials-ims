// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/runtime-config/alert-settings.js'); }
catch { mod = await import('../_shared/core.bundle.mjs'); }
export const isAlertingEnabled = mod.isAlertingEnabled;
export const _resetForTest = mod._resetForTest;
