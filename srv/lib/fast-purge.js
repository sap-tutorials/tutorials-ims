// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/fast-purge.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const purgeTags = mod.purgeTags;
export const purgePublishedSlugs = mod.purgePublishedSlugs;
export const purgeAllContent = mod.purgeAllContent;
export const _makeAuthHeaderForTest = mod._makeAuthHeaderForTest;
export const _edgeGridTimestampForTest = mod._edgeGridTimestampForTest;
export const _itemTagsForSlugsForTest = mod._itemTagsForSlugsForTest;
export const _setFetchForTest = mod._setFetchForTest;
export const _resetForTest = mod._resetForTest;
