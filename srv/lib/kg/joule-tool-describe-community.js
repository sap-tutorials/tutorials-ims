// Workspace-first shim — full surface in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/kg/joule-tool-describe-community.js'); }
catch { mod = await import('../_shared/kg.bundle.mjs'); }
export const DESCRIBE_COMMUNITY_TOOL = mod.DESCRIBE_COMMUNITY_TOOL;
export const describeCommunityHandler = mod.describeCommunityHandler;
