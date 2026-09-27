// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/mcp/mcp-developer-tools.js'); }
catch { mod = await import('./_shared/mcp.bundle.mjs'); }
export const handleGetMyTutorials = mod.handleGetMyTutorials;
export const handleGetMyMissions = mod.handleGetMyMissions;
export const handleGetMyEvents = mod.handleGetMyEvents;
export const handleGetMyCompletedSteps = mod.handleGetMyCompletedSteps;
export const handleGetTutorialStep = mod.handleGetTutorialStep;
export const handleCompleteStep = mod.handleCompleteStep;
export const handleResetTutorialProgress = mod.handleResetTutorialProgress;
