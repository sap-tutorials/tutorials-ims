// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/channels/build-channel-detail.js'); }
catch { mod = await import('./_shared/channels.bundle.mjs'); }
export const buildChannelDetailPayload = mod.buildChannelDetailPayload;
