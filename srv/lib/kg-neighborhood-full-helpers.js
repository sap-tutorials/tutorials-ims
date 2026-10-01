// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-neighborhood-full-helpers.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT_DEFAULT = mod.KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT_DEFAULT;
export const buildOtherResourcesByType = mod.buildOtherResourcesByType;
