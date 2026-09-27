// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('./_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/safe-fetch.js'); }
export const isLiteralPrivateAddress = mod.isLiteralPrivateAddress;
export const _setLookupForTests = mod._setLookupForTests;
export const resolveAndCheckHost = mod.resolveAndCheckHost;
export const safeFetch = mod.safeFetch;
