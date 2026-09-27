// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('../lib/_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/jobs/job-lock.js'); }
export const acquireLock = mod.acquireLock;
export const releaseLock = mod.releaseLock;
