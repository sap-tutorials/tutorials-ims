// srv/lib/rate-limit/agent-identity.js
//
// Tier resolver for the origin-side rate limiter. Identity here is a *tier*,
// NOT an access gate — an unknown caller is never blocked, just held to the
// anon bucket. The whole point is zero setup for arbitrary consumers while
// still giving our own first-party agents (MCP / A2A) more headroom.
//
// resolveTier(req) -> { tier: 'trusted'|'auth'|'anon', clientKey: string|null }
//
//   trusted — the request carries a VALID HMAC signature (our first-party
//             agents). HMAC-SHA256 over `keyId\nMETHOD\nPATH\nTIMESTAMP`, with a
//             ±5-min timestamp window to bound replay. Secret via
//             resolveSecret('AGENT_HMAC_SECRET') (BTP Credential Store, rotatable
//             through /admin-ui/#secrets). No secret configured → trusted tier is
//             simply unavailable (callers fall through to auth/anon).
//   auth    — a bearer token / api-key is ALREADY present (PAT, XSUAA). We do
//             NOT validate it here (that happens downstream in CAP) — presence is
//             enough to grant a higher bucket, and we key off a hash of the token
//             so the bucket is per-token, not per-shared-NAT-IP. Zero new setup.
//   anon    — everything else. clientKey is null; the caller keys off client IP.
//
// Body is deliberately NOT part of the signed canonical string: this middleware
// runs at the express bootstrap layer where the body is not yet parsed, and this
// is a rate-limit tier (not an auth gate) — an attacker cannot forge a signature
// without the secret, and a captured signature only buys trusted-rate access to
// the SAME method+path for at most the 5-min window. Acceptable for tiering.

import cds from '@sap/cds';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { resolveSecret } from '../secret-resolver.js';

const LOG = cds.log('rate-limit');

const HMAC_SECRET_ALIAS = 'AGENT_HMAC_SECRET';
const SIG_HEADER = 'x-agent-signature'; // hex-encoded HMAC-SHA256
const TS_HEADER = 'x-agent-timestamp'; // unix epoch milliseconds
const KEYID_HEADER = 'x-agent-key-id'; // optional caller identifier, defaults to 'default'
const SKEW_MS = 5 * 60 * 1000; // replay / clock-skew window

function sha256hex(s) {
  return createHash('sha256').update(String(s ?? '')).digest('hex');
}
// 16 hex chars (64 bits) is plenty to disambiguate callers in a cache key while
// never storing the raw token/secret material.
function shortHash(s) {
  return sha256hex(s).slice(0, 16);
}

async function verifyHmac(req) {
  const sig = req.headers?.[SIG_HEADER];
  const ts = req.headers?.[TS_HEADER];
  if (!sig || !ts) return null;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > SKEW_MS) return null; // stale/forged timestamp

  const secret = await resolveSecret(HMAC_SECRET_ALIAS, { logTag: '[rate-limit]' });
  if (!secret) return null; // trusted tier not provisioned

  const keyId = String(req.headers?.[KEYID_HEADER] || 'default');
  const path = req.originalUrl || req.url || '';
  const canonical = `${keyId}\n${req.method}\n${path}\n${ts}`;
  const expected = createHmac('sha256', secret).update(canonical).digest();

  let provided;
  try {
    provided = Buffer.from(String(sig), 'hex');
  } catch {
    return null;
  }
  // timingSafeEqual throws on length mismatch — guard first.
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  return { tier: 'trusted', clientKey: `hmac:${keyId}` };
}

// A bearer token or api-key already on the request → 'auth' tier, keyed off a
// hash of the credential (never the raw value).
function authClientKey(req) {
  const auth = req.headers?.authorization;
  if (auth && /^bearer\s+\S/i.test(String(auth))) return shortHash(auth);
  const apiKey = req.headers?.['x-api-key'] || req.headers?.['apikey'];
  if (apiKey) return shortHash(String(apiKey));
  return null;
}

/**
 * Resolve the rate-limit tier for a request. NEVER throws (fail-open to anon).
 * @returns {Promise<{tier:'trusted'|'auth'|'anon', clientKey:string|null}>}
 */
export async function resolveTier(req) {
  try {
    const trusted = await verifyHmac(req);
    if (trusted) return trusted;
  } catch (err) {
    LOG.warn(`HMAC verify error (treating as untrusted): ${err.message}`);
  }
  const authKey = authClientKey(req);
  if (authKey) return { tier: 'auth', clientKey: `auth:${authKey}` };
  return { tier: 'anon', clientKey: null };
}

// Test seam: build the canonical string a client must sign, so a test can
// produce a valid signature deterministically.
export function _canonicalForTest({ keyId = 'default', method, path, ts }) {
  return `${keyId}\n${method}\n${path}\n${ts}`;
}
