// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('./_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/credstore.js'); }
export const readSecret = mod.readSecret;
export const writeSecret = mod.writeSecret;
export const deleteSecret = mod.deleteSecret;
export const _resetForTests = mod._resetForTests;
