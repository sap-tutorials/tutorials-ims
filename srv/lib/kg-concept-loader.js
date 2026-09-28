// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-concept-loader.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const bufferToFloat32Array = mod.bufferToFloat32Array;
export const loadConceptsWithEmbeddings = mod.loadConceptsWithEmbeddings;
