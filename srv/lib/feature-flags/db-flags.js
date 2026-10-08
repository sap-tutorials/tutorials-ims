// Worktree-local-first: prefer the live packages/ source so a git worktree
// (where node_modules/@tutorials/core symlinks to the ROOT repo's packages/)
// loads the correct registry, not a stale one. Falls back to the workspace
// package and then the pre-built bundle for CF deploy.
let mod;
try { mod = await import('../../packages/core/feature-flags/db-flags.js'); }
catch {
  try { mod = await import('@tutorials/core/feature-flags/db-flags.js'); }
  catch { mod = await import('../_shared/core.bundle.mjs'); }
}
export const FLAG_TTL_MS = mod.FLAG_TTL_MS;
export const refreshFeatureFlags = mod.refreshFeatureFlags;
export const bustFeatureFlagsCache = mod.bustFeatureFlagsCache;
export const ensureFeatureFlagDefaults = mod.ensureFeatureFlagDefaults;
export const isFlagEnabled = mod.isFlagEnabled;
export const managedFlagKeys = mod.managedFlagKeys;
export const flagMeta = mod.flagMeta;
export const __setFlagForTest = mod.__setFlagForTest;
export const __resetFlagsForTest = mod.__resetFlagsForTest;
