// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/topic-slug.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const slugifyTopic = mod.slugifyTopic;
export const flattenTopicSlug = mod.flattenTopicSlug;
export const parseTitlePath = mod.parseTitlePath;
export const buildTopicSlugMap = mod.buildTopicSlugMap;
export const normalizeLegacyTopicSlug = mod.normalizeLegacyTopicSlug;
