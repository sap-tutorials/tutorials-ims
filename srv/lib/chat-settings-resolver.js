// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('./_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/chat-settings-resolver.js'); }
export const resolveChatLlmSettings = mod.resolveChatLlmSettings;
export const resolveEmbeddingSettings = mod.resolveEmbeddingSettings;
