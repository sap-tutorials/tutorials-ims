// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/credstore.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const readSecret = mod.readSecret;
export const writeSecret = mod.writeSecret;
export const deleteSecret = mod.deleteSecret;
export const _resetForTests = mod._resetForTests;
