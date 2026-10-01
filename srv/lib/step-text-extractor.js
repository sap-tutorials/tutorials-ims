// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/step-text-extractor.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const MAX_CHUNK_CHARS = mod.MAX_CHUNK_CHARS;
export const extractStepText = mod.extractStepText;
