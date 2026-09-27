// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('./_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/task-record-submission-id.js'); }
export const stampSubmissionId = mod.stampSubmissionId;
