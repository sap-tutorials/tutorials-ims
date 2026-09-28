// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/channels/publish-channels.js'); }
catch { mod = await import('./_shared/channels.bundle.mjs'); }
export const channelMetaDescription = mod.channelMetaDescription;
export const renderChannelsIntoSession = mod.renderChannelsIntoSession;
export const createRenderChannels = mod.createRenderChannels;
export const renderChannelsHandler = mod.renderChannelsHandler;
