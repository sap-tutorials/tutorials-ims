// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-similarity.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const cosineSim = mod.cosineSim;
export const pickCanonical = mod.pickCanonical;
export const findNearDuplicates = mod.findNearDuplicates;
export const findNearDuplicatesChunked = mod.findNearDuplicatesChunked;
