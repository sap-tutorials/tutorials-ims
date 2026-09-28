// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/category-classifier.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const classifyAndPersist = mod.classifyAndPersist;
export const HIGH_THRESHOLD = mod.HIGH_THRESHOLD;
export const AMBIGUITY_GAP = mod.AMBIGUITY_GAP;
export const MAX_CATEGORIES = mod.MAX_CATEGORIES;
