// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('./_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/_tutorials-table.js'); }
export const tutorialsTableInfo = mod.tutorialsTableInfo;
