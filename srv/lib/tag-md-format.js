// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/tag-md-format.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const titlePathToMdFormat = mod.titlePathToMdFormat;
export const applyMdFormat = mod.applyMdFormat;
