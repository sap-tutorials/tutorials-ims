// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/mcp/tutorial-step-slicer.js'); }
catch { mod = await import('./_shared/mcp.bundle.mjs'); }
export const sliceStep = mod.sliceStep;
export const sliceStepMarkdown = mod.sliceStepMarkdown;
export const sliceAllSteps = mod.sliceAllSteps;
export const invalidateSlug = mod.invalidateSlug;
export const _resetConnection = mod._resetConnection;
