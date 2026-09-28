// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-neighborhood-cache.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const getCachedNeighborhood = mod.getCachedNeighborhood;
export const setCachedNeighborhood = mod.setCachedNeighborhood;
export const bustNeighborhoodCache = mod.bustNeighborhoodCache;
export const _makeKey = mod._makeKey;
export const _resetConnection = mod._resetConnection;
