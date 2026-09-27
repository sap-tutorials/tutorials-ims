// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('./_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/step-text-extractor.js'); }
export const MAX_CHUNK_CHARS = mod.MAX_CHUNK_CHARS;
export const extractStepText = mod.extractStepText;
