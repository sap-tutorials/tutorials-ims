// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/published-concepts-query.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const HELP_DOC_SOURCE_LABEL = mod.HELP_DOC_SOURCE_LABEL;
export const anchorToLabel = mod.anchorToLabel;
export const buildConceptsPayload = mod.buildConceptsPayload;
