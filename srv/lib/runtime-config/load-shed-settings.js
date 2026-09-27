// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/runtime-config/load-shed-settings.js'); }
catch { mod = await import('../_shared/core.bundle.mjs'); }
export const DEFAULT_CONFIG = mod.DEFAULT_CONFIG;
export const resolveLoadShedConfig = mod.resolveLoadShedConfig;
export const _resetForTest = mod._resetForTest;
export const _primeForTest = mod._primeForTest;
