// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/provenance-freshness.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const FRESH_MAX_AGE_DAYS = mod.FRESH_MAX_AGE_DAYS;
export const STALE_AGE_DAYS = mod.STALE_AGE_DAYS;
export const deriveConfidence = mod.deriveConfidence;
