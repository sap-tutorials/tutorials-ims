// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('./_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/semaphore-tags.js'); }
export const getSemaphoreMdMap = mod.getSemaphoreMdMap;
export const formatSmTechIds = mod.formatSmTechIds;
