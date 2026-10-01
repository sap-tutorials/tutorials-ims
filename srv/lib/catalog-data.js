// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/catalog-data.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const resolveSmTechIds = mod.resolveSmTechIds;
export const loadGroupContext = mod.loadGroupContext;
export const loadMissionContext = mod.loadMissionContext;
