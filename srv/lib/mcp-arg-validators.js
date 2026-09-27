// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/mcp/mcp-arg-validators.js'); }
catch { mod = await import('./_shared/mcp.bundle.mjs'); }
export const assertRange = mod.assertRange;
export const assertEnum = mod.assertEnum;
export const clampLimit = mod.clampLimit;
