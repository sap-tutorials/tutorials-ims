// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/resolve-db-user.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const resolveUserSapId = mod.resolveUserSapId;
export const resolveDbUser = mod.resolveDbUser;
export const emailFromUser = mod.emailFromUser;
export const backfillUserProfile = mod.backfillUserProfile;
export const provisionDbUser = mod.provisionDbUser;
export const isIasToken = mod.isIasToken;
export const iasEmailFromToken = mod.iasEmailFromToken;
export const resolveIasSapId = mod.resolveIasSapId;
export const pinIasSapId = mod.pinIasSapId;
