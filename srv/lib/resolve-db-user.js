// Workspace-first: full surface (incl. test seams) in local dev; bundle fallback at CF deploy.
let mod;
try { mod = await import('@tutorials/core/resolve-db-user.js'); }
catch { mod = await import('./_shared/core.bundle.mjs'); }
export const resolveUserSapId = mod.resolveUserSapId;
export const resolveDbUser = mod.resolveDbUser;
export const emailFromUser = mod.emailFromUser;
export const backfillUserProfile = mod.backfillUserProfile;
export const refreshUserPicture = mod.refreshUserPicture;
export const provisionDbUser = mod.provisionDbUser;
export const resolveUser = mod.resolveUser;
export const issuerSubjectFromUser = mod.issuerSubjectFromUser;
export const tokenEmail = mod.tokenEmail;
export const writeIdentityLink = mod.writeIdentityLink;
export const pinResolvedUser = mod.pinResolvedUser;
