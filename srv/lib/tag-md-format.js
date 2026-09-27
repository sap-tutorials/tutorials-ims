// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('./_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/tag-md-format.js'); }
export const titlePathToMdFormat = mod.titlePathToMdFormat;
export const applyMdFormat = mod.applyMdFormat;
