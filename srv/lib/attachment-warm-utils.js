// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/attachment-warm-utils.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const channelFor = mod.channelFor;
export const resolveAttachmentSourceUrl = mod.resolveAttachmentSourceUrl;
export const extractAttachmentUrls = mod.extractAttachmentUrls;
export const warmAttachments = mod.warmAttachments;
