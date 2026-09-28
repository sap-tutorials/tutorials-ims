// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-other-resources-loader.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const loadOtherResourcesByType = mod.loadOtherResourcesByType;
export const buildEventMetaText = mod.buildEventMetaText;
export const buildSessionMetaText = mod.buildSessionMetaText;
