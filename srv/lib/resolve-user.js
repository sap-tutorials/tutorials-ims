// srv/lib/resolve-user.js
// Robust resolver for "who is this request authenticated as?" — handles the
// gap between CAP's two user surfaces:
//
//   - cds.context.user — canonical, set by cds.middlewares.auth().
//     Per CAP June-2024 release notes, this is "the public API".
//
//   - req.user — set by some auth strategies (mocked-auth, basic-auth) but
//     NOT reliably mirrored from cds.context.user on JWT-based XSUAA paths
//     in production. Treated as "internal to authentication strategies".
//
// Picking just one breaks: prefer-req.user fails on deployed XSUAA (was the
// bug behind PR #535). Prefer-cds.context.user fails when stream-based
// middleware like multer drops the AsyncLocalStorage scope between the
// auth middleware and the handler (Tom hit this 2026-06-22, after #535).
//
// The right thing is: try EVERY candidate, pick the first one that has a
// real user id (not undefined, not 'anonymous'). If none qualify, return
// null and let the caller emit 401.

/**
 * Find the first candidate that represents an authenticated, non-anonymous
 * user. Returns the user object, or null if none qualify.
 *
 * Acceptable shapes: `{ id, is?, attr?, roles?, ... }` — anything CAP-ish.
 */
export function pickAuthenticatedUser(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    if (!c.id) continue;
    if (c.id === 'anonymous') continue;
    return c;
  }
  return null;
}

/**
 * Resolve the user for an Express handler that might or might not be inside
 * an AsyncLocalStorage scope. Tries cds.context.user first (canonical) then
 * req.user (legacy fallback). Stream-based middleware (multer, busboy) can
 * sometimes drop the AsyncLocalStorage scope; for those routes, register an
 * early-capture middleware before the stream parser (see captureUserMiddleware).
 *
 * @param {{ user?: any, _capturedUser?: any }} req — Express request
 * @param {{ context?: { user?: any } }} cds — @sap/cds module (passed for testability)
 * @returns {object|null} The first authenticated user found, or null.
 */
export function resolveUser(req, cds) {
  return pickAuthenticatedUser(
    req?._capturedUser,        // Stashed by captureUserMiddleware before multer
    cds?.context?.user,        // Canonical CAP source
    req?.user                  // Legacy fallback
  );
}

/**
 * Express middleware that captures the authenticated user onto req.
 * Install BEFORE any stream-based body parser (multer, busboy) so the user
 * is preserved if the AsyncLocalStorage scope is later lost.
 *
 * Usage:
 *   const cds = require('@sap/cds');
 *   app.post('/route',
 *     cds.middlewares.context(),
 *     cds.middlewares.auth(),
 *     captureUserMiddleware(cds),    // <-- HERE, before multer
 *     multer().single('file'),
 *     (req, res) => { const user = resolveUser(req, cds); ... }
 *   );
 */
export function captureUserMiddleware(cds) {
  return (req, _res, next) => {
    // Capture from whichever surface has it RIGHT NOW (before stream parser
    // runs). Both surfaces may be populated; we keep whichever has a real id.
    req._capturedUser = pickAuthenticatedUser(cds?.context?.user, req?.user);
    next();
  };
}
