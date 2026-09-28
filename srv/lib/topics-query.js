// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/topics-query.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const loadLiveTags = mod.loadLiveTags;
export const buildTopicsTreePayload = mod.buildTopicsTreePayload;
export const resolveTopicBySlug = mod.resolveTopicBySlug;
export const loadTopicCorpus = mod.loadTopicCorpus;
export const buildTopicDetailPayload = mod.buildTopicDetailPayload;
