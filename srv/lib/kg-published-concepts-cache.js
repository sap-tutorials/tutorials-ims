// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-published-concepts-cache.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const PUBLISHED_CONCEPTS_TAG = mod.PUBLISHED_CONCEPTS_TAG;
export const bustPublishedConceptsCache = mod.bustPublishedConceptsCache;
export const _resetConnection = mod._resetConnection;
