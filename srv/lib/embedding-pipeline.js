// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/embedding-pipeline.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const embedSlugs = mod.embedSlugs;
export const triggerPostPublishEmbeddings = mod.triggerPostPublishEmbeddings;
export const linkTutorialAuthorship = mod.linkTutorialAuthorship;
