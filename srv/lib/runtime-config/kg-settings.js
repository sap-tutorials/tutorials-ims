// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-settings.js'); }
catch { mod = await import('../_shared/kg.bundle.mjs'); }
export const resolveKnowledgeGraphSettings = mod.resolveKnowledgeGraphSettings;
export const _resetCacheForTests = mod._resetCacheForTests;
