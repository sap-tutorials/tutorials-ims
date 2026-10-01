// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-meta-formatters.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const formatRelativeMonth = mod.formatRelativeMonth;
export const formatDate = mod.formatDate;
export const formatLevel = mod.formatLevel;
