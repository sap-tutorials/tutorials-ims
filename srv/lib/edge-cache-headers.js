// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('./_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/edge-cache-headers.js'); }
export const CONTENT_CACHE_CONTROL = mod.CONTENT_CACHE_CONTROL;
export const cacheTagsFor = mod.cacheTagsFor;
export const setContentCacheHeaders = mod.setContentCacheHeaders;
