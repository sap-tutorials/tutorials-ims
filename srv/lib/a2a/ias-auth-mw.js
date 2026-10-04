// Route-scoped IAS (+XSUAA fallback) auth middleware for POST /a2a.
//
// Background (#2593 → DEV login outage, 2026-10-04): #2593 set a SERVICE-WIDE
// cds.requires.auth = {kind:'ias', xsuaa:true} to let the a2a (agent-to-agent)
// surface accept IAS client-credentials tokens. On the deployed DEV srv the
// XSUAA fallback did NOT engage, so every browser XSUAA token failed audience
// validation against the IAS client → all authenticated routes 500/401. The
// service-wide auth kind was the "single highest-risk change" the #2593 spec
// itself flagged (docs/.../2026-10-04-a2a-ias-auth-migration-design.md).
//
// Fix (route-scoped IAS, user-approved): drop the service-wide auth kind so
// human routes revert to their pre-#2593 known-good XSUAA-via-approuter path,
// and validate IAS/XSUAA tokens ONLY here, on the single machine-to-machine
// endpoint that needs it. This reuses CAP's own ias-auth factory (same code
// path global auth uses), so the downstream contract in rpc-router.js (reads
// cds.context.user.id, rejects anonymous with -32001/401) is unchanged.
//
// Degrade-closed: if the IAS binding is absent (unit tests, local dev) or CAP's
// internal factory module moves on upgrade, this returns a pass-through that
// leaves the user anonymous — rpc-router.js then rejects with 401. It never
// throws into boot and never affects any route other than /a2a.

import cds from '@sap/cds';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LOG = cds.log('a2a');

// CAP's ias auth middleware factory is an INTERNAL (non-released-API) path.
// Per the project rule against depending on unpublished internals, we require
// it defensively: a failure here degrades /a2a to anonymous, it does not crash.
const IAS_AUTH_FACTORY_PATH = '@sap/cds/lib/srv/middlewares/auth/ias-auth';

// Instance names of the bound services (see .deploy/mta.yaml / mta.yaml).
const IAS_BINDING_NAME = 'tutorials-identity';
const XSUAA_BINDING_NAME = 'tutorials-xsuaa';

// Pass-through used whenever IAS validation can't be wired. Leaves the user
// untouched (anonymous) so the existing rpc-router anonymous guard returns 401.
const PASS_THROUGH = (_req, _res, next) => next();

let _cached; // memoized (req,res,next) middleware; built on first use.

/**
 * Lazily build the route-scoped IAS (+XSUAA fallback) auth middleware.
 * Built on first request (not at import) because service bindings are not
 * present in VCAP_SERVICES during unit tests / local boot.
 * @returns {(req, res, next) => void}
 */
function buildIasAuthMiddleware() {
  let xsenv;
  let makeIasAuth;
  try {
    xsenv = require('@sap/xsenv');
    makeIasAuth = require(IAS_AUTH_FACTORY_PATH);
  } catch (err) {
    LOG.warn(
      `/a2a IAS auth unavailable (require failed: ${err.message}); ` +
        'a2a will reject as anonymous. Human routes are unaffected.',
    );
    return PASS_THROUGH;
  }

  // CAP's factory is a CJS default export; interop may wrap it as { default }.
  const factory = typeof makeIasAuth === 'function' ? makeIasAuth : makeIasAuth?.default;
  if (typeof factory !== 'function') {
    LOG.warn('/a2a IAS auth factory export is not callable; a2a will reject as anonymous.');
    return PASS_THROUGH;
  }

  let ias;
  let xsuaa;
  try {
    ({ ias, xsuaa } = xsenv.getServices({
      ias: { name: IAS_BINDING_NAME },
      xsuaa: { name: XSUAA_BINDING_NAME },
    }));
  } catch (err) {
    // Missing bindings (unit/local) — degrade closed, no a2a auth.
    LOG.warn(
      `/a2a IAS binding '${IAS_BINDING_NAME}' not found (${err.message}); ` +
        'a2a will reject as anonymous.',
    );
    return PASS_THROUGH;
  }

  if (!ias || !ias.clientid) {
    LOG.warn(`/a2a IAS binding '${IAS_BINDING_NAME}' has no credentials; a2a will reject as anonymous.`);
    return PASS_THROUGH;
  }

  // Expose the XSUAA binding under cds.env.requires.xsuaa.credentials so CAP's
  // ias-auth factory builds its automatic XSUAA-fallback service (non-breaking
  // acceptance of XSUAA bearers during the a2a token-source cutover).
  const hasXsuaa = Boolean(xsuaa && xsuaa.clientid);
  if (hasXsuaa) {
    cds.env.requires = cds.env.requires || {};
    cds.env.requires.xsuaa = { ...(cds.env.requires.xsuaa || {}), kind: 'xsuaa', credentials: xsuaa };
  }

  try {
    const mw = factory({
      kind: 'ias',
      credentials: ias,
      // Point the factory at the requires entry we just populated so it wires
      // the XSUAA fallback. Omitted when no XSUAA binding → IAS-only.
      ...(hasXsuaa ? { xsuaa: 'xsuaa' } : {}),
    });
    LOG.info(
      `/a2a IAS auth wired (IAS '${IAS_BINDING_NAME}'` +
        `${hasXsuaa ? ` + XSUAA fallback '${XSUAA_BINDING_NAME}'` : ''}).`,
    );
    return typeof mw === 'function' ? mw : PASS_THROUGH;
  } catch (err) {
    LOG.warn(`/a2a IAS auth factory failed (${err.message}); a2a will reject as anonymous.`);
    return PASS_THROUGH;
  }
}

/**
 * Route-scoped auth middleware for POST /a2a. Validates an IAS bearer (with
 * XSUAA fallback) and populates cds.context.user via CAP's own mapping; on any
 * failure the user is left anonymous and rpc-router.js returns 401. MUST run
 * after contextMw (which establishes cds.context).
 */
export function a2aIasAuthMiddleware(req, res, next) {
  if (_cached === undefined) _cached = buildIasAuthMiddleware();
  return _cached(req, res, next);
}

// Test seam: reset the memoized middleware so unit tests can rebuild against
// a mocked binding environment.
export function __resetForTests() {
  _cached = undefined;
}
