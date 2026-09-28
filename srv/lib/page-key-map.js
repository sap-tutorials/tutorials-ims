// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/page-key-map.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const PAGE_KEY_PREFIX = mod.PAGE_KEY_PREFIX;
export const extForMime = mod.extForMime;
export const IN_SCOPE_PAGES = mod.IN_SCOPE_PAGES;
export const pageKeyForPath = mod.pageKeyForPath;
export const pathForPageKey = mod.pathForPageKey;
export const isPageKey = mod.isPageKey;
export const mimeTypeForPageKey = mod.mimeTypeForPageKey;
export const discoverPageFiles = mod.discoverPageFiles;
export const AUTHOR_KEY_PREFIX = mod.AUTHOR_KEY_PREFIX;
export const isAuthorKey = mod.isAuthorKey;
export const discoverAuthorPages = mod.discoverAuthorPages;
export const ADVOCATE_KEY_PREFIX = mod.ADVOCATE_KEY_PREFIX;
export const isAdvocateKey = mod.isAdvocateKey;
export const discoverAdvocatePages = mod.discoverAdvocatePages;
