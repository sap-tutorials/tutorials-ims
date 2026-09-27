// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('../_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/feature-flags/registry.js'); }
export const KINDS = mod.KINDS;
export const ENV_RULES = mod.ENV_RULES;
export const STATUSES = mod.STATUSES;
export const FEATURE_FLAGS = mod.FEATURE_FLAGS;
