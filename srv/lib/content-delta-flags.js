// Prefer the CF-deploy bundle; fall back to the workspace package in local dev.
let mod;
try { mod = await import('./_shared/core.bundle.mjs'); }
catch { mod = await import('@tutorials/core/content-delta-flags.js'); }
export const DELTA_WRITE_KEY = mod.DELTA_WRITE_KEY;
export const DELTA_READ_KEY = mod.DELTA_READ_KEY;
export const DELTA_SKIP_CARRYFORWARD_KEY = mod.DELTA_SKIP_CARRYFORWARD_KEY;
export const FLAG_TTL_MS = mod.FLAG_TTL_MS;
export const refreshContentDeltaFlags = mod.refreshContentDeltaFlags;
export const bustContentDeltaFlagsCache = mod.bustContentDeltaFlagsCache;
export const ensureContentDeltaDefaults = mod.ensureContentDeltaDefaults;
export const isDeltaWrite = mod.isDeltaWrite;
export const isDeltaRead = mod.isDeltaRead;
export const isDeltaSkipCarryForward = mod.isDeltaSkipCarryForward;
