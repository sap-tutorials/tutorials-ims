// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('./_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/secret-resolver.js'); }
export const resolveSecret = mod.resolveSecret;
export const invalidateSecret = mod.invalidateSecret;
export const _resetForTests = mod._resetForTests;
export const _primeForTests = mod._primeForTests;
