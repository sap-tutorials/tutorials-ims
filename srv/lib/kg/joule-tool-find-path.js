// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/joule-tool-find-path.js'); }
catch { mod = await import('../_shared/kg.bundle.mjs'); }
export const FIND_LEARNING_PATH_TOOL = mod.FIND_LEARNING_PATH_TOOL;
export const findLearningPathHandler = mod.findLearningPathHandler;
