// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/mcp/mcp-progress-store.js'); }
catch { mod = await import('./_shared/mcp.bundle.mjs'); }
export const getMyTutorials = mod.getMyTutorials;
export const getMyMissions = mod.getMyMissions;
export const getMyEvents = mod.getMyEvents;
export const getMyCompletedSteps = mod.getMyCompletedSteps;
