// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/channels/media-diet-export.js'); }
catch { mod = await import('./_shared/channels.bundle.mjs'); }
export const enforceIdCap = mod.enforceIdCap;
export const buildOpml = mod.buildOpml;
export const buildBookmarksHtml = mod.buildBookmarksHtml;
