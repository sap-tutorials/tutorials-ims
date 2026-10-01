// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/resolve-tutorial-author.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const resolveTutorialAuthor = mod.resolveTutorialAuthor;
