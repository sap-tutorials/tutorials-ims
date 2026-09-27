// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('../_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/runtime-config/alert-settings.js'); }
export const isAlertingEnabled = mod.isAlertingEnabled;
export const _resetForTest = mod._resetForTest;
