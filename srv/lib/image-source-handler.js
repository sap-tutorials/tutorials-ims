// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/image-source-handler.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const imageSourceHandler = mod.imageSourceHandler;
export const warmImages = mod.warmImages;
export const channelFor = mod.channelFor;
export const extractImgCdnUrls = mod.extractImgCdnUrls;
export const warmImagesLive = mod.warmImagesLive;
