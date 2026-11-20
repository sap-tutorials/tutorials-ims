// srv-sage/lib/resolve-db-user.js
//
// Workspace-first shim for @tutorials/core/resolve-db-user.js.
// Mirrors srv/lib/resolve-db-user.js and srv-mcp/developer-service.js.
//
// Local dev (workspace symlink) resolves from @tutorials/core directly.
// CF deploy falls back to the bundled core.bundle.mjs shipped beside this
// file at srv-sage/lib/_shared/core.bundle.mjs via scripts/bundle-shared.cjs.
//
// Only the exports needed by AuthorSageService are re-exported here — this
// keeps the bundle footprint minimal. Do NOT import from srv/ — srv-sage is
// an isolated module that must not cross-import from the main app.
//
// (#task-4 — srv-sage handler helpers)

let mod;
try {
  mod = await import('@tutorials/core/resolve-db-user.js');
} catch {
  mod = await import('./_shared/core.bundle.mjs');
}

export const resolveUserSapId  = mod.resolveUserSapId;
export const resolveDbUser     = mod.resolveDbUser;
export const provisionDbUser   = mod.provisionDbUser;
export const pinResolvedUser   = mod.pinResolvedUser;
export const tokenEmail        = mod.tokenEmail;
export const issuerSubjectFromUser = mod.issuerSubjectFromUser;
