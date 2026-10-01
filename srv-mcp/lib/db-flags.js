// Workspace-first: full surface in local dev; bundle fallback at CF deploy.
// @tutorials/core is stripped from gen/srv-mcp/package.json before CF staging
// (bundle-shared.cjs bakes it into srv-mcp/lib/_shared/core.bundle.mjs).
// This shim mirrors the pattern in srv/lib/resolve-db-user.js and
// srv-mcp/lib/developer-service.js so server.js can import feature-flag
// helpers without a bare static workspace import that would throw at CF boot.
let mod;
try { mod = await import('@tutorials/core/feature-flags/db-flags.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const FLAG_TTL_MS = mod.FLAG_TTL_MS;
export const refreshFeatureFlags = mod.refreshFeatureFlags;
export const bustFeatureFlagsCache = mod.bustFeatureFlagsCache;
export const ensureFeatureFlagDefaults = mod.ensureFeatureFlagDefaults;
export const isFlagEnabled = mod.isFlagEnabled;
export const managedFlagKeys = mod.managedFlagKeys;
export const flagMeta = mod.flagMeta;
