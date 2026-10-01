// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-tutorial-teaches-map.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const computeTutorialTeachesMap = mod.computeTutorialTeachesMap;
export const getTutorialTeachesMap = mod.getTutorialTeachesMap;
export const bustTutorialTeachesCache = mod.bustTutorialTeachesCache;
