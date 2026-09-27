// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/semaphore-tags.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const getSemaphoreMdMap = mod.getSemaphoreMdMap;
export const formatSmTechIds = mod.formatSmTechIds;
