// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/search-kg-handler.js'); }
catch { mod = await import('../_shared/kg.bundle.mjs'); }
export const searchKgHandler = mod.searchKgHandler;
