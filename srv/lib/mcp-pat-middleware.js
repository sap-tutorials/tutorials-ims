// Express middleware: recognizes Bearer pat_... tokens and installs a
// synthetic req.user before @cap-js/mcp dispatches. Mounted under URL
// prefix /mcp-pat/ only — a stray Bearer header on other routes is
// never misinterpreted.
//
// Phase 2 — issue #1105.

import cds from '@sap/cds';
import crypto from 'node:crypto';
import LRUCache from 'lru-cache';

const LOG = cds.log('mcp-pat');
const NS = 'com.sap.developers.ims';

// TTL 60s — bounded revocation window << any credible attack duration.
export const _cache = new LRUCache({ max: 5000, ttl: 60 * 1000 });

function respond401(res, err = 'invalid_token') {
  res.setHeader('WWW-Authenticate', `Bearer error="${err}"`);
  return res.status(401).json({ error: err });
}

function installSyntheticUser(req, cached) {
  req.user = {
    id: cached.email,
    is: (role) => role === 'authenticated-user' || (Array.isArray(cached.roles) && cached.roles.includes(role)),
    attr: cached.attr ?? {},
    tokenSource: 'pat',
    authInfo: { token: { userId: cached.sapId } },
    _dbUserId: cached.userId,
    _patId: cached.patId,
    _patScopes: cached.scopes
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

  let entry = _cache.get(hashHex);
  if (!entry) {
    entry = await lookupPAT(hashHex);
    if (entry) _cache.set(hashHex, entry);
  }

  if (!isValid(entry)) return respond401(res);
  installSyntheticUser(req, entry);
  bumpLastUsed(entry.patId);
  return next();
}

export default patMiddleware;
