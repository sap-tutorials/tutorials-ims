// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/user-progress.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const getUserProgress = mod.getUserProgress;
export const getMyCompletedTutorials = mod.getMyCompletedTutorials;
export const getMyCompletedTutorialsForPoints = mod.getMyCompletedTutorialsForPoints;
export const getMyInProgressTutorials = mod.getMyInProgressTutorials;
export const getProgressLookup = mod.getProgressLookup;
