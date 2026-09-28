// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-explore-data.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const SHORT_BY_TYPE = mod.SHORT_BY_TYPE;
export const buildExplorePayload = mod.buildExplorePayload;
