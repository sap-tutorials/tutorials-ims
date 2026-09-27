// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('../_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/feature-flags/db-flags.js'); }
export const FLAG_TTL_MS = mod.FLAG_TTL_MS;
export const refreshFeatureFlags = mod.refreshFeatureFlags;
export const bustFeatureFlagsCache = mod.bustFeatureFlagsCache;
export const ensureFeatureFlagDefaults = mod.ensureFeatureFlagDefaults;
export const isFlagEnabled = mod.isFlagEnabled;
export const managedFlagKeys = mod.managedFlagKeys;
export const flagMeta = mod.flagMeta;
export const __setFlagForTest = mod.__setFlagForTest;
export const __resetFlagsForTest = mod.__resetFlagsForTest;
