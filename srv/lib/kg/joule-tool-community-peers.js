// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/joule-tool-community-peers.js'); }
catch { mod = await import('../_shared/kg.bundle.mjs'); }
export const FIND_COMMUNITY_PEERS_TOOL = mod.FIND_COMMUNITY_PEERS_TOOL;
export const findCommunityPeersHandler = mod.findCommunityPeersHandler;
