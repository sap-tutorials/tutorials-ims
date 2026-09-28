// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/per-user-rate-limit.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const checkRateLimit = mod.checkRateLimit;
export const _resetForTests = mod._resetForTests;
