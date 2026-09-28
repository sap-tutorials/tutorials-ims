// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/content/category-seed-embeddings.js'); }
catch { mod = await import('./_shared/content.bundle.mjs'); }
export const getSeedEmbeddings = mod.getSeedEmbeddings;
export const embedAdHoc = mod.embedAdHoc;
export const invalidateSeedEmbedding = mod.invalidateSeedEmbedding;
export const _resetCache = mod._resetCache;
