// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/co-completion.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const computeCoCompletions = mod.computeCoCompletions;
export const loadCoCompletionsFor = mod.loadCoCompletionsFor;
export const coCompletionsHandler = mod.coCompletionsHandler;
