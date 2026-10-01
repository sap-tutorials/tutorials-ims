// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/feature-flags/registry.js'); }
catch { mod = await import('../_shared/core.bundle.mjs'); }
export const KINDS = mod.KINDS;
export const ENV_RULES = mod.ENV_RULES;
export const STATUSES = mod.STATUSES;
export const FEATURE_FLAGS = mod.FEATURE_FLAGS;
