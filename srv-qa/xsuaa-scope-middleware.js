// srv-qa/xsuaa-scope-middleware.js
//
// Express middleware that enforces an XSUAA scope on the JWT in the
// `Authorization: Bearer ...` header. Used to lock down the public CF URL of
// `tutorials-srv-qa` so anonymous traffic cannot bypass the approuter's
// `Tutorial.Author` route gate by hitting the srv directly.
//
// Behaviour:
//   - CAP auth.kind != 'xsuaa' (mocked-auth: unit tests, local dev) → no-op.
//     CAP itself only validates JWTs when configured for xsuaa, so this
//     mirrors that contract: enforcement is active in production / hybrid
//     deployments where xsuaa is the bound auth provider.
//   - auth.kind == 'xsuaa' but XSUAA binding missing/malformed → fail closed
//     with 503 { error: 'service_unavailable' }. This is the "configured but
//     misbehaving" case — defense in depth so a broken binding can never leave
//     the route open.
//   - Missing / malformed Authorization header → 401 { error: 'unauthorized' }
//   - Invalid / expired JWT                    → 401 { error: 'unauthorized' }
//     (Intentional: bad JWT is the common case; rare upstream UAA errors also
//     surface as 401 — operationally fine and avoids leaking failure modes.)
//   - Valid JWT but missing required scope      → 403 { error: 'forbidden' }
//   - Valid JWT with required scope             → next()

import cds from '@sap/cds';
import xsenv from '@sap/xsenv';
import xssec from '@sap/xssec';

const { createSecurityContext, XsuaaService } = xssec;

const LOG = cds.log('qa-security');

let xsuaaServiceCache = null;
let xsuaaInitAttempted = false;
let xsuaaBindingMissing = false; // true when authKind=xsuaa but binding fetch failed

// Lazily construct the XsuaaService from bound credentials.
// Returns:
//   - XsuaaService instance when bound and authKind === 'xsuaa'
//   - null when authKind !== 'xsuaa' (mocked-auth: pass-through allowed)
//   - null AND sets xsuaaBindingMissing=true when authKind === 'xsuaa' but the
//     binding is missing/malformed (caller must fail closed with 503)
// Cached after first call. Underlying error logged once.
function getXsuaaService() {
  if (xsuaaInitAttempted) return xsuaaServiceCache;
  xsuaaInitAttempted = true;

  const authKind = cds.env?.requires?.auth?.kind;
  if (authKind && authKind !== 'xsuaa') {
    LOG.info(`auth.kind="${authKind}" — scope enforcement disabled (mocked-auth mode)`);
    xsuaaServiceCache = null;
    return null;
  }

  try {
    xsenv.loadEnv();
    const creds = xsenv.serviceCredentials({ label: 'xsuaa' });
    if (!creds) {
      throw new Error('xsenv.serviceCredentials returned no credentials');
    }
    xsuaaServiceCache = new XsuaaService(creds);
    LOG.info('XSUAA service initialised, scope enforcement active');
  } catch (err) {
    // authKind === 'xsuaa' but binding unavailable: configured but misbehaving.
    // Mark so requests fail closed (503), don't silently pass through.
    LOG.error('XSUAA binding missing/malformed — failing closed:', err.message);
    xsuaaServiceCache = null;
    xsuaaBindingMissing = true;
  }
  return xsuaaServiceCache;
}

/**
 * Build an Express middleware that enforces `requiredScope` on the JWT.
 * @param {string} requiredScope — local scope name (e.g. 'Tutorial.Author');
 *   passed to `securityContext.checkLocalScope` which prefixes with the app id.
 */
export function requireXsuaaScope(requiredScope) {
  return async function xsuaaScopeMiddleware(req, res, next) {
    const service = getXsuaaService();
    // authKind === 'xsuaa' but binding missing: fail closed.
    if (!service && xsuaaBindingMissing) {
      return res.status(503).json({ error: 'service_unavailable' });
    }
    // authKind !== 'xsuaa' (mocked auth, unit tests, local dev) → pass through.
    if (!service) return next();

    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const secContext = await createSecurityContext(service, { req });
      if (!secContext.checkLocalScope(requiredScope)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      return next();
    } catch (err) {
      // Validation errors (expired, wrong audience, malformed) → 401.
      // Anything else → also 401 to avoid leaking internal failure modes on a
      // public, unauthenticated probe surface.
      LOG.warn('JWT validation failed:', err.message);
      return res.status(401).json({ error: 'unauthorized' });
    }
  };
}

// Test seam: reset the cached service so a unit test can force re-init.
export function _resetForTests() {
  xsuaaServiceCache = null;
  xsuaaInitAttempted = false;
  xsuaaBindingMissing = false;
}
