// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/kg-cycles.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const findCycles = mod.findCycles;
