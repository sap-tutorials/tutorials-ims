// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/provenance-data.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const loadProvenanceInputs = mod.loadProvenanceInputs;
