// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/branch/slug-key.js'); }
catch { mod = await import('../_shared/core.bundle.mjs'); }
export const slugifyKey = mod.slugifyKey;
