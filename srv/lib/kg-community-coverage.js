// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-community-coverage.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const computeCoverage = mod.computeCoverage;
export const resolveThreshold = mod.resolveThreshold;
export const DEFAULT_THRESHOLD = mod.DEFAULT_THRESHOLD;
