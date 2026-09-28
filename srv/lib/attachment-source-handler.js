// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/attachment-source-handler.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const attachmentSourceHandler = mod.attachmentSourceHandler;
export const warmAttachmentsLive = mod.warmAttachmentsLive;
export const warmAttachments = mod.warmAttachments;
export const resolveAttachmentSourceUrl = mod.resolveAttachmentSourceUrl;
export const extractAttachmentUrls = mod.extractAttachmentUrls;
