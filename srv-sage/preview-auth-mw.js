// Route-scoped IAS (+XSUAA fallback) auth middleware for POST /preview/render.
//
// Why this exists: /preview/render is a custom Express route registered in
// cds.on('bootstrap'), which runs OUTSIDE CAP's service-level auth middleware.
// CAP only populates req.user / cds.context.user for CAP service handlers
// (e.g. AuthorSageService), NOT for routes mounted on the raw Express app at
// bootstrap. So the original guard `if (!req.user?.id) return 401` rejected
// EVERY request — even with a valid IAS bearer — which is why author ops worked
// (CAP services) but preview 401'd ("unauthenticated"). This middleware
// validates the IAS bearer itself (with XSUAA fallback) via CAP's own ias-auth
// factory and populates cds.context.user, so the route can gate on an actual
// authenticated identity.
//
// Ported from srv/lib/a2a/ias-auth-mw.js (the proven in-repo pattern for a
// route-scoped IAS gate), adjusted for srv-sage's bindings: IAS instance
// 'tutorials-sage-identity', XSUAA resolved by label ('xsuaa') with the dev
// instance name 'tutorials-xsuaa' as fallback (prod is 'xsuaa-imsprod').
//
// Degrade-closed: if the IAS binding is absent (unit tests / local dev) or CAP's
// internal factory module moves on upgrade, this returns a guard that REJECTS
// with 401 (unlike the a2a pass-through, which relied on a downstream anonymous
// guard — preview has none, so this must fail closed itself). It never throws
// into boot and never affects any route other than /preview/render.

import cds from '@sap/cds';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LOG = cds.log('sage');

// CAP's ias auth middleware factory is an INTERNAL (non-released-API) path.
// Required defensively: a failure here degrades /preview/render to a
// reject-all guard, it does not crash boot.
const IAS_AUTH_FACTORY_PATH = '@sap/cds/lib/srv/middlewares/auth/ias-auth';

// Bound service identifiers (see mta-sage.yaml). The IAS instance is
// tutorials-sage-identity (dedicated SAGE public client). The XSUAA instance
// name differs per space (dev: 'tutorials-xsuaa', prod: 'xsuaa-imsprod'), so
// XSUAA is resolved by its service LABEL ('xsuaa') with the dev name as
// fallback — mirroring the #2649 fix in the a2a middleware.
const IAS_BINDING_NAME = 'tutorials-sage-identity';
const XSUAA_SERVICE_LABEL = 'xsuaa';
const XSUAA_BINDING_NAME = 'tutorials-xsuaa';

// Fail-closed guard used whenever IAS validation can't be wired. Preview has no
// downstream anonymous guard, so this middleware must reject by itself.
const REJECT = (_req, res) => res.status(401).json({ error: 'unauthenticated' });

let _cached; // memoized (req,res,next) middleware; built on first use.

function buildIasAuthMiddleware() {
  let xsenv;
  let makeIasAuth;
  try {
    xsenv = require('@sap/xsenv');
    makeIasAuth = require(IAS_AUTH_FACTORY_PATH);
  } catch (err) {
    LOG.warn(
      `/preview/render IAS auth unavailable (require failed: ${err.message}); ` +
        'preview will reject as unauthenticated.',
    );
    return REJECT;
  }

  const factory = typeof makeIasAuth === 'function' ? makeIasAuth : makeIasAuth?.default;
  if (typeof factory !== 'function') {
    LOG.warn('/preview/render IAS auth factory export is not callable; preview will reject.');
    return REJECT;
  }

  // IAS is REQUIRED — resolve it alone so a missing/renamed XSUAA binding can
  // never take IAS down with it.
  let ias;
  try {
    ({ ias } = xsenv.getServices({ ias: { name: IAS_BINDING_NAME } }));
  } catch (err) {
    LOG.warn(
      `/preview/render IAS binding '${IAS_BINDING_NAME}' not found (${err.message}); ` +
        'preview will reject as unauthenticated.',
    );
    return REJECT;
  }

  if (!ias || !ias.clientid) {
    LOG.warn(`/preview/render IAS binding '${IAS_BINDING_NAME}' has no credentials; preview will reject.`);
    return REJECT;
  }

  // XSUAA is OPTIONAL — a non-breaking fallback accepting XSUAA bearers. Resolve
  // by LABEL so it works regardless of per-space instance name; fall back to the
  // dev name. If absent, proceed IAS-only.
  let xsuaa;
  try {
    ({ xsuaa } = xsenv.getServices({ xsuaa: { label: XSUAA_SERVICE_LABEL } }));
  } catch (byLabelErr) {
    try {
      ({ xsuaa } = xsenv.getServices({ xsuaa: { name: XSUAA_BINDING_NAME } }));
    } catch (byNameErr) {
      LOG.info(
        `/preview/render XSUAA fallback binding not found (label '${XSUAA_SERVICE_LABEL}': ${byLabelErr.message}); ` +
          'proceeding IAS-only.',
      );
    }
  }

  const hasXsuaa = Boolean(xsuaa && xsuaa.clientid);
  if (hasXsuaa) {
    cds.env.requires = cds.env.requires || {};
    cds.env.requires.xsuaa = { ...(cds.env.requires.xsuaa || {}), kind: 'xsuaa', credentials: xsuaa };
  }

  let iasMw;
  try {
    iasMw = factory({
      kind: 'ias',
      credentials: ias,
      ...(hasXsuaa ? { xsuaa: 'xsuaa' } : {}),
    });
    LOG.info(
      `/preview/render IAS auth wired (IAS '${IAS_BINDING_NAME}'` +
        `${hasXsuaa ? ` + XSUAA fallback (label '${XSUAA_SERVICE_LABEL}')` : ', IAS-only'}).`,
    );
  } catch (err) {
    LOG.warn(`/preview/render IAS auth factory failed (${err.message}); preview will reject.`);
    return REJECT;
  }

  if (typeof iasMw !== 'function') return REJECT;

  // Wrap CAP's ias-auth middleware so that after it runs we REQUIRE a
  // non-anonymous user — CAP's middleware populates cds.context.user but does
  // not itself 401 on anonymous for a raw route. Fail closed.
  return (req, res, next) => {
    iasMw(req, res, (err) => {
      if (err) return res.status(401).json({ error: 'unauthenticated' });
      const user = cds.context?.user || req.user;
      if (!user || !user.id || user.id === 'anonymous' || user._is_anonymous) {
        return res.status(401).json({ error: 'unauthenticated' });
      }
      next();
    });
  };
}

/**
 * Route-scoped auth middleware for POST /preview/render. Validates an IAS bearer
 * (with XSUAA fallback), populates cds.context.user, and rejects anonymous with
 * 401. MUST run before express.json() so an unauthenticated 50 MB body is never
 * buffered.
 */
export function previewIasAuthMiddleware(req, res, next) {
  if (_cached === undefined) _cached = buildIasAuthMiddleware();
  return _cached(req, res, next);
}

// Test seam: reset the memoized middleware so unit tests can rebuild against a
// mocked binding environment.
export function __resetForTests() {
  _cached = undefined;
}
