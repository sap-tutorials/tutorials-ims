// srv/lib/mcp-pat-actions.js
// PAT mint/revoke handlers for AdminService.
// Full plaintext is returned exactly once in the mint response body and
// stored ONLY as SHA-256 hex in the PATs table. Prefix ("pat_XXXXXXXX") is
// stored for user-facing identification (list-report column).
//
// Token format: pat_<8 hex chars>_<48 base64url chars>
// The prefix uses hex (always alphanumeric) to ensure exactly 8 chars.
//
// Refs #1105.

import cds from '@sap/cds';
import crypto from 'node:crypto';
import { resolveDbUser } from './resolve-db-user.js';
import { invalidateCacheByPatId } from './mcp-pat-middleware.js';
import * as metrics from './metrics.js';

const VALID_SCOPES = new Set(['read', 'write']);
const MIN_TTL = 1;
const MAX_TTL = 365;
const DEFAULT_TTL = 90;

function assertValidScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error('scopes must be a non-empty array');
  }
  for (const s of scopes) {
    if (!VALID_SCOPES.has(s)) throw new Error(`unknown scope: ${s}`);
  }
}

function clampTtl(ttlDays) {
  const n = Number.isFinite(ttlDays) ? ttlDays : DEFAULT_TTL;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, n));
}

/**
 * Generate "pat_<8 hex chars>_<~48 base64url chars>" and its SHA-256 hash.
 * Uses hex for the prefix so length is deterministically 8 alnum chars.
 */
function generateToken() {
  // hex gives [0-9a-f] — always alphanumeric, deterministic length.
  const prefixPart = crypto.randomBytes(4).toString('hex'); // exactly 8 chars
  const prefix = `pat_${prefixPart}`;
  const secret = crypto.randomBytes(36).toString('base64url'); // ~48 chars, base64url
  const token = `${prefix}_${secret}`;
  const hashHex = crypto.createHash('sha256').update(token).digest('hex');
  return { token, prefix, hashHex };
}

export async function handleMintPAT(req) {
  if (process.env.MCP_PAT_MINT_ENABLED === 'false') return req.reject(503, 'PAT minting is disabled');
  const { name, scopes, ttlDays } = req.data;
  if (!name || typeof name !== 'string') return req.error(400, 'name is required');
  try { assertValidScopes(scopes); } catch (e) { return req.error(400, e.message); }

  const dbUser = await resolveDbUser(req.user);
  if (!dbUser) return req.error(401, 'unable to resolve user');

  const { token, prefix, hashHex } = generateToken();
  const ttl = clampTtl(ttlDays);
  const expiresAt = new Date(Date.now() + ttl * 24 * 3600 * 1000);
  const clientIP = (req.headers?.['x-forwarded-for'] || req._?.req?.ip || '').split(',')[0].trim().slice(0, 45);

  const { PATs } = cds.entities('com.sap.developers.ims');
  const ID = crypto.randomUUID();
  await INSERT.into(PATs).entries({
    ID, user_ID: dbUser.ID, name, prefix, hashHex,
    scopes, expiresAt, createdFromIP: clientIP || null
  });

  metrics.counter('mcp.pat.mint');
  return { ID, token, prefix, expiresAt };
}

export async function handleRevokePAT(req) {
  // #1132: revokePAT is now a BOUND action on PatService.MyPATs. FE V4
  // supplies the row key via `req.params` (the last entry is this entity's
  // key object). We fall back to `req.data.ID` so the handler still works if
  // ever invoked as an unbound action (older callers / direct sends).
  const boundKey = Array.isArray(req.params) && req.params.length
    ? req.params[req.params.length - 1]
    : null;
  const ID = boundKey?.ID ?? req.data?.ID;
  if (!ID) return req.error(400, 'ID is required');

  const dbUser = await resolveDbUser(req.user);
  if (!dbUser) return req.error(401, 'unable to resolve user');

  const { PATs } = cds.entities('com.sap.developers.ims');
  const [row] = await SELECT.from(PATs).where({ ID });
  if (!row) return req.error(404, 'PAT not found');
  // Non-admins may only revoke their own tokens.
  if (row.user_ID !== dbUser.ID && !req.user.is('Admin')) return req.error(403, 'forbidden');

  const revokedAt = new Date();
  await UPDATE(PATs).set({ revokedAt }).where({ ID });
  // Immediately purge the middleware cache — closes the 60s TTL revocation
  // gap on single-instance deploys (security-review fix, #1105).
  invalidateCacheByPatId(ID);
  metrics.counter('mcp.pat.revoke');
  return { ok: true, revokedAt };
}
