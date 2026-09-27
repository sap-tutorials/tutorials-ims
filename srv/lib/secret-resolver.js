// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/secret-resolver.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const resolveSecret = mod.resolveSecret;
export const invalidateSecret = mod.invalidateSecret;
export const _resetForTests = mod._resetForTests;
export const _primeForTests = mod._primeForTests;
