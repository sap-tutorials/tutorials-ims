// Workspace-first shim: resolves @tutorials/mcp handlers in local dev;
// falls back to the CF deploy bundle at srv-mcp/lib/_shared/mcp.bundle.mjs.
// Mirrors the pattern in srv/lib/mcp-developer-tools.js.
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
