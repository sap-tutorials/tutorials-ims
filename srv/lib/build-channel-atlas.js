// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/channels/build-channel-atlas.js'); }
catch { mod = await import('./_shared/channels.bundle.mjs'); }
export const buildAtlasChannels = mod.buildAtlasChannels;
