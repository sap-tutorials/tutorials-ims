// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/external-content-ttl.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const PER_TYPE_TTL_DAYS = mod.PER_TYPE_TTL_DAYS;
export const isWithinTTL = mod.isWithinTTL;
