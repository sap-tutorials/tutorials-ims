// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/on-demand-enqueue.js'); }
catch { mod = await import('../_shared/kg.bundle.mjs'); }
export const normalizeQuery = mod.normalizeQuery;
export const enqueueOnDemandExtraction = mod.enqueueOnDemandExtraction;
