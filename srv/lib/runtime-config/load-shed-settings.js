// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('../_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/runtime-config/load-shed-settings.js'); }
export const DEFAULT_CONFIG = mod.DEFAULT_CONFIG;
export const resolveLoadShedConfig = mod.resolveLoadShedConfig;
export const _resetForTest = mod._resetForTest;
export const _primeForTest = mod._primeForTest;
