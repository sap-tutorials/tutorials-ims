// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/edge-cache-headers.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const CONTENT_CACHE_CONTROL = mod.CONTENT_CACHE_CONTROL;
export const cacheTagsFor = mod.cacheTagsFor;
export const setContentCacheHeaders = mod.setContentCacheHeaders;
