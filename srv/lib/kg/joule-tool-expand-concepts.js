// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/joule-tool-expand-concepts.js'); }
catch { mod = await import('../_shared/kg.bundle.mjs'); }
export const EXPAND_SEARCH_CONCEPTS_TOOL = mod.EXPAND_SEARCH_CONCEPTS_TOOL;
export const expandSearchConceptsHandler = mod.expandSearchConceptsHandler;
