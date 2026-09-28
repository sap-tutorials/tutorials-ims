// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-extract.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const KG_EXTRACT_SCHEMA = mod.KG_EXTRACT_SCHEMA;
export const extractConceptsCore = mod.extractConceptsCore;
export const extractConceptsFromTutorial = mod.extractConceptsFromTutorial;
