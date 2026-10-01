// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-merge-on-write.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const loadConceptRegistry = mod.loadConceptRegistry;
export const findBestMatch = mod.findBestMatch;
export const resolveConceptCandidates = mod.resolveConceptCandidates;
export const vectorToJsonLiteral = mod.vectorToJsonLiteral;
export const insertMintedConcept = mod.insertMintedConcept;
