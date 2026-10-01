// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-path-v2-client.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const kgPathV2 = mod.kgPathV2;
