// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('./_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/pipeline-log.js'); }
export const logPipelineStart = mod.logPipelineStart;
export const logPipelineEnd = mod.logPipelineEnd;
export const logPipeline = mod.logPipeline;
export const logPipelineItem = mod.logPipelineItem;
export const logJobItem = mod.logJobItem;
