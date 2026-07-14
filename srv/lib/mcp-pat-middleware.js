// Express middleware: recognizes Bearer pat_... tokens and installs a
// synthetic req.user before @cap-js/mcp dispatches. Mounted under URL
// prefix /mcp-pat/ only — a stray Bearer header on other routes is
// never misinterpreted.
//
// Phase 2 — issue #1105.

import cds from '@sap/cds';
import crypto from 'node:crypto';
import * as metrics from './metrics.js';

const LOG = cds.log('mcp-pat');
const NS = 'com.sap.developers.ims';

// PAT-auth cache, backed by the shared `caching` service (cds-caching plugin,
// issue #1180 — replaces the former hand-rolled lru-cache). TTL 60s bounds the
// revocation window << any credible attack duration. In prod (Redis/HANA store)
// entries are shared across CF instances, so revocation now propagates fleet-wide
// instead of per-instance.
//
// Cache key: `pat:<sha256(token)>`. Each entry is tagged `pat-id:<patId>` so a
// single `deleteByTag` in `invalidateCacheByPatId` purges every cached hash for
// one PAT — the tag-based successor to the old O(cache-size) entry walk, and it
// now closes the 60s revocation gap on MULTI-instance deploys too.
const TTL_MS = 60 * 1000;

function makeKey(hashHex) {
  return `pat:${hashHex}`;
}
function patTag(patId) {
  return `pat-id:${patId}`;
}

// Memoized connection to the caching service. See kg-neighborhood-cache.js
// (#1177) for the same pattern — a burst of concurrent lookups on a cold
// module shares one connect round-trip.
let _cachePromise;
function cache() {
  if (!_cachePromise) _cachePromise = cds.connect.to('caching');
  return _cachePromise;
}

/** Read a cached PAT entry by token hash. Fail-open: any caching-service
 *  fault resolves to null (treated as a miss), so the middleware falls through
 *  to the DB lookup rather than erroring on a request hot path. */
async function cacheGet(hashHex) {
  try {
    const c = await cache();
    const v = await c.get(makeKey(hashHex));
    return v == null ? null : v;
  } catch (err) {
    LOG.warn(`cache get failed, treating as miss: ${err.message}`);
    return null;
  }
}

/** Store a PAT entry, tagged for per-PAT invalidation. Fail-open: a store
 *  fault is logged and swallowed — the next request just re-reads from the DB. */
async function cacheSet(hashHex, entry) {
  try {
    const c = await cache();
    await c.set(makeKey(hashHex), entry, {
      ttl: TTL_MS,
      tags: [{ value: patTag(entry.patId) }],
    });
  } catch (err) {
    LOG.warn(`cache set failed, entry not cached: ${err.message}`);
  }
}

/** Purge every cached entry for the PAT with the given ID.
 *  Called from `handleRevokePAT` to close the 60s TTL revocation gap.
 *  Now a single tag delete (fleet-wide on shared stores) instead of an
 *  in-process entry walk. Fail-open: a fault is logged; entries then expire
 *  via TTL. Async — the caller awaits. */
export async function invalidateCacheByPatId(patId) {
  try {
    const c = await cache();
    await c.deleteByTag(patTag(patId));
  } catch (err) {
    LOG.warn(`cache invalidate failed for ${patId}, relying on TTL: ${err.message}`);
  }
}

/** Test seam: reset the memoized connection so a test booting a fresh cds
 *  runtime doesn't reuse a stale service handle. */
export function _resetConnection() {
  _cachePromise = undefined;
}

function respond401(res, err = 'invalid_token') {
  res.setHeader('WWW-Authenticate', `Bearer error="${err}"`);
  return res.status(401).json({ error: err });
}

function installSyntheticUser(req, cached) {
  const scopes = Array.isArray(cached.scopes) ? cached.scopes : [];
  const scopeRoles = new Set();
  // Scope → pseudo-role mapping (Phase 2 #1105, security-review fix).
  // Write handlers (complete_step, reset_tutorial_progress on Task 12) MUST
  // gate on 'pat-write' via @requires. Read handlers stay at
  // @requires: 'authenticated-user' — every PAT that reaches this line has
  // already passed the 'authenticated-user' predicate via the shared
  // `role === 'authenticated-user'` branch below.
  if (scopes.includes('read')) scopeRoles.add('pat-read');
  if (scopes.includes('write')) scopeRoles.add('pat-write');

  req.user = {
    id: cached.email,
    is: (role) => role === 'authenticated-user'
      || scopeRoles.has(role)
      || (Array.isArray(cached.roles) && cached.roles.includes(role)),
    attr: cached.attr ?? {},
    tokenSource: 'pat',
    authInfo: { token: { userId: cached.sapId } },
    _dbUserId: cached.userId,
    _patId: cached.patId,
    _patScopes: scopes
  };
}

async function lookupPAT(hashHex) {
  const { PATs, Users } = cds.entities(NS);
  const [row] = await SELECT.from(PATs).where({ hashHex });
  if (!row) return null;
  const [user] = await SELECT.from(Users).where({ ID: row.user_ID });
  if (!user) return null;
  return {
    patId: row.ID,
    userId: row.user_ID,
    email: user.email,
    sapId: user.sapId ?? null,
    scopes: row.scopes ?? [],
    expiresAt: row.expiresAt ? new Date(row.expiresAt).getTime() : null,
    revokedAt: row.revokedAt ? new Date(row.revokedAt).getTime() : null,
    roles: [],
    attr: { email: user.email, displayName: user.displayName }
  };
}

function isValid(entry) {
  if (!entry) return false;
  if (entry.revokedAt) return false;
  if (entry.expiresAt && entry.expiresAt < Date.now()) return false;
  return true;
}

/** Fire-and-forget lastUsedAt bump. Swallow errors. */
function bumpLastUsed(patId) {
  const { PATs } = cds.entities(NS);
  UPDATE(PATs).set({ lastUsedAt: new Date() }).where({ ID: patId })
    .then(() => {}, (err) => LOG.warn(`bumpLastUsed failed for ${patId}:`, err.message));
}

export async function patMiddleware(req, res, next) {
  const authz = req.headers?.authorization;
  if (!authz || !authz.startsWith('Bearer pat_')) return next();

  const token = authz.slice('Bearer '.length);
  const hashHex = crypto.createHash('sha256').update(token).digest('hex');

  let entry = await cacheGet(hashHex);
  if (!entry) {
    entry = await lookupPAT(hashHex);
    if (entry) await cacheSet(hashHex, entry);
  }

  if (!isValid(entry)) {
    const outcome = !entry ? 'miss' : entry.revokedAt ? 'revoked' : 'expired';
    metrics.counter(`mcp.pat.auth[outcome=${outcome}]`);
    return respond401(res);
  }
  metrics.counter('mcp.pat.auth[outcome=hit]');
  installSyntheticUser(req, entry);
  // Strip the Bearer pat_ header so CAP's downstream xsuaa/ias auth strategy
  // does NOT try to JWT-parse the PAT. jwt-auth / xssec do
  // `if (!req.headers.authorization) return next()` (verified in
  // @sap/cds/lib/srv/middlewares/auth/jwt-auth.js:31) — so with the header
  // gone they no-op WITHOUT overwriting the user. Without this strip the
  // strategy threw InvalidJwtError ("invalid base64") → 401, discarding the
  // synthetic user (Phase 2 #1105 — deployed xsuaa path; local mocked-auth
  // never JWT-parsed, so this was invisible until the live PAT probe).
  //
  // The synthetic user rides on `req.user`; `pinPatUserToContext` (registered
  // after CAP's `auth` middleware in server.js) copies it onto cds.context.user
  // inside the per-request ALS scope, where @cap-js/mcp's checkAuthorization
  // reads it (auth.js: `const user = cds.context?.user`). We CANNOT set
  // cds.context.user here — this bootstrap/root-scope middleware runs before
  // CAP's context() establishes the per-request ALS context.
  delete req.headers.authorization;
  bumpLastUsed(entry.patId);
  return next();
}

/**
 * Post-auth middleware: copy the PAT synthetic user from req.user onto
 * cds.context.user inside CAP's per-request ALS scope. Registered via
 * cds.middlewares.add(..., { after: 'auth' }) in server.js so it runs AFTER
 * context() has established cds.context and auth() has (harmlessly) no-op'd on
 * the stripped header. Only acts on PAT requests (tokenSource==='pat'); a
 * no-op for every other request. See patMiddleware above (Phase 2 #1105).
 */
export function pinPatUserToContext(req, _res, next) {
  if (req.user?.tokenSource === 'pat' && cds.context) {
    cds.context.user = req.user;
  }
  next();
}

export default patMiddleware;
