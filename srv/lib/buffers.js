// Workspace-first: full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/buffers.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const toBuffer = mod.toBuffer;
