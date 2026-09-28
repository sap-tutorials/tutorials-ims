// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-path.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const findPath = mod.findPath;
export const findPathV2OrV1 = mod.findPathV2OrV1;
export const parsePathSparql = mod.parsePathSparql;
