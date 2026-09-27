// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/jobs/job-lock.js'); }
catch { mod = await import('../lib/_shared/core.bundle.mjs'); }
export const acquireLock = mod.acquireLock;
export const releaseLock = mod.releaseLock;
