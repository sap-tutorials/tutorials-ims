// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/search-kg-signal.js'); }
catch { mod = await import('./_shared/kg.bundle.mjs'); }
export const KG_WEIGHT = mod.KG_WEIGHT;
export const KG_COMMUNITY_WEIGHT = mod.KG_COMMUNITY_WEIGHT;
export const COMMUNITY_TOP_K = mod.COMMUNITY_TOP_K;
export const _resetForTest = mod._resetForTest;
export const _setTestEmbedClient = mod._setTestEmbedClient;
export const peekSignal = mod.peekSignal;
export const computeKgSignal = mod.computeKgSignal;
export const buildKgRankFragment = mod.buildKgRankFragment;
export const buildCommunityRankFragment = mod.buildCommunityRankFragment;
