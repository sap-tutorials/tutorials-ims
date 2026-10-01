// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/channels/mcp-channels-search.js'); }
catch { mod = await import('./_shared/channels.bundle.mjs'); }
export const mapChannelRow = mod.mapChannelRow;
export const handleSearchChannels = mod.handleSearchChannels;
