// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-neighborhood-merge.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const MAX_OTHER_RESOURCES = mod.MAX_OTHER_RESOURCES;
export const mergeOtherResources = mod.mergeOtherResources;
