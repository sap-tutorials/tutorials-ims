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
// Added in #2651 — pickCanonicalRow is exported from the worktree/bundle
// but the workspace symlink may point to a version that predates Task 2.
// Export it here as the canonical re-export point for srv/jobs consumers.
export const pickCanonicalRow = mod.pickCanonicalRow;
