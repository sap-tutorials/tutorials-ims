// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/pipeline-log.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const logPipelineStart = mod.logPipelineStart;
export const logPipelineEnd = mod.logPipelineEnd;
export const logPipeline = mod.logPipeline;
export const logPipelineItem = mod.logPipelineItem;
export const logJobItem = mod.logJobItem;
