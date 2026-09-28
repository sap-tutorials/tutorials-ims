// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/discovery-mission-categories.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const CATEGORY_LABELS = mod.CATEGORY_LABELS;
export const categoryLabel = mod.categoryLabel;
