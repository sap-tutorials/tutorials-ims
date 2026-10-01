// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/image-warm-utils.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const channelFor = mod.channelFor;
export const extractImgCdnUrls = mod.extractImgCdnUrls;
export const warmImages = mod.warmImages;
