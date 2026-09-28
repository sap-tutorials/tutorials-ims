// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/_search-fetches.js'); }
catch { mod = await import('../_shared/kg.bundle.mjs'); }
export const isHana = mod.isHana;
export const fetchEdges = mod.fetchEdges;
export const fetchConceptsByIds = mod.fetchConceptsByIds;
export const fetchLinks = mod.fetchLinks;
export const fetchTutorialsByIds = mod.fetchTutorialsByIds;
export const fetchCommunityFingerprints = mod.fetchCommunityFingerprints;
export const fetchCommunityMembers = mod.fetchCommunityMembers;
export const fetchExternalContentLinks = mod.fetchExternalContentLinks;
