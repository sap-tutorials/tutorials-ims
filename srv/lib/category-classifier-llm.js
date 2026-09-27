// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/category-classifier-llm.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const classifyViaLlm = mod.classifyViaLlm;
