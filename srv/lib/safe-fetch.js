// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/safe-fetch.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const isLiteralPrivateAddress = mod.isLiteralPrivateAddress;
export const _setLookupForTests = mod._setLookupForTests;
export const resolveAndCheckHost = mod.resolveAndCheckHost;
export const safeFetch = mod.safeFetch;
