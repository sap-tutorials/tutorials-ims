// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/content-cache-coherence.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const onCacheGenerationChange = mod.onCacheGenerationChange;
export const refreshCacheGeneration = mod.refreshCacheGeneration;
export const bumpCacheGeneration = mod.bumpCacheGeneration;
export const invalidateContentCache = mod.invalidateContentCache;
export const ContentCache = mod.ContentCache;
export const DEFAULT_CONTENT_CACHE_TTL_MS = mod.DEFAULT_CONTENT_CACHE_TTL_MS;
export const CHECK_TTL_MS = mod.CHECK_TTL_MS;
export const GEN_KEY = mod.GEN_KEY;
export const _resetForTest = mod._resetForTest;
export const _setCachingForTest = mod._setCachingForTest;
