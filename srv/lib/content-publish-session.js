// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/content-publish-session.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const createSessionHelpers = mod.createSessionHelpers;
export const classifyTouchedTutorials = mod.classifyTouchedTutorials;
export const linkTutorialAuthorship = mod.linkTutorialAuthorship;
