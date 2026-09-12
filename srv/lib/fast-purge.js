// srv/lib/fast-purge.js
//
// Akamai Fast-Purge (CCU v3) purge-by-tag hook for the content-serving edge
// (PR2 of the origin-abuse-protection sequence; see the plan + the
// docs/developers/architecture/cdn-caching.md §"Invalidation on publish").
//
// Why this exists: developers.sap.com fronts with Akamai. Content is served
// per-request from HANA gzip BLOBs with a split browser/edge Cache-Control
// (srv/lib/edge-cache-headers.js). Without an active purge signal the ONLY
// thing bounding edge staleness after a publish is `s-maxage`, so that TTL has
// to stay short (10 min). Wiring a purge-by-tag call on the publish path lets
// the edge hold content much longer (offloading scraper/bot floods away from
// HANA — the biggest availability win) while a publish invalidates the exact
// changed items within seconds.
//
// Design constraints honored here:
//   - Master flag EDGE_PURGE_ENABLED (ImsConfig flag.edgepurge, default OFF).
//     Off → every entry point is a no-op: no secret read, no network. This is
//     also what makes dev a natural mock (no Akamai credential bound → no-op).
//   - FAIL-OPEN + FIRE-AND-FORGET everywhere. A purge fault (missing/garbled
//     credential, network blip, Akamai 5xx) must NEVER fail a content commit or
//     rollback. Callers use purgePublishedSlugs()/purgeAllContent() which return
//     void and swallow all errors; the awaitable purgeTags() (used by tests)
//     also never throws.
//   - No new dependency: the Akamai EG1-HMAC-SHA256 request signing is
//     implemented with node:crypto (the algorithm is a documented HMAC-SHA256
//     construction). Native fetch performs the call (AbortSignal timeout).
//   - Env-free: the credential bundle is one JSON secret in Credential Store
//     (alias AKAMAI_FASTPURGE_EDGERC), resolved via secret-resolver.js and
//     rotatable through /admin-ui/#secrets. Numeric/string tunables come from
//     ImsConfig (edgepurge.*), never process.env (blue-green drops set-env).

import cds from '@sap/cds';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { resolveSecret } from './secret-resolver.js';
import { cacheTagsFor } from './edge-cache-headers.js';
import { isFlagEnabled } from './feature-flags/db-flags.js';
import { counter } from './metrics.js';

const LOG = cds.log('fast-purge');
const NS = 'com.sap.developers.ims';

// Credential Store alias holding the EdgeGrid credentials as a JSON string:
//   {"host":"akab-….purge.akamaiapis.net","client_token":"akab-…",
//    "client_secret":"…","access_token":"akab-…"}
const SECRET_ALIAS = 'AKAMAI_FASTPURGE_EDGERC';

// Coarse tags that must NOT drive a targeted per-publish purge: purging any of
// these would invalidate the whole corpus / whole category on a single-slug
// publish. cacheTagsFor() always includes 'content'; category pages also carry
// 'group'/'mission'/'page'/'concepts'. We keep only the per-item tags.
const COARSE_TAGS = new Set(['content', 'group', 'mission', 'page', 'concepts']);

// Akamai caps objects per Fast-Purge request; batch conservatively.
const MAX_TAGS_PER_CALL = 100;

// ---- config (ImsConfig-backed, ~5s cache, never throws) --------------------
// Mirrors srv/lib/runtime-config/rate-limit-settings.js but kept inline so this
// hook adds exactly one file to the srv-qa cp list.
const TTL_MS = 5_000;
const CFG_KEY = Symbol.for('com.sap.developers.ims:fast-purge-settings');
const _cfgState = (globalThis[CFG_KEY] ??= { cached: null, cachedAt: 0 });

const DEFAULT_CFG = Object.freeze({
  network: 'production', // Akamai purge network: 'production' | 'staging'
  timeoutMs: 5_000,
});

async function resolveConfig() {
  const now = Date.now();
  if (_cfgState.cached && now - _cfgState.cachedAt < TTL_MS) return _cfgState.cached;
  const cfg = { ...DEFAULT_CFG };
  try {
    if (typeof cds.entities === 'function') {
      const db = await cds.connect.to('db');
      const { ImsConfig } = cds.entities(NS);
      const rows = await db.run(
        SELECT.from(ImsConfig)
          .columns('key', 'value')
          .where({ key: { in: ['edgepurge.network', 'edgepurge.timeoutMs'] } })
      );
      for (const r of rows || []) {
        if (r.key === 'edgepurge.network' && (r.value === 'production' || r.value === 'staging')) {
          cfg.network = r.value;
        } else if (r.key === 'edgepurge.timeoutMs') {
          const n = Number(r.value);
          if (Number.isFinite(n) && n >= 500 && n <= 60_000) cfg.timeoutMs = n;
        }
      }
    }
  } catch (err) {
    LOG.warn(`config read failed; using defaults: ${err.message}`);
  }
  _cfgState.cached = cfg;
  _cfgState.cachedAt = now;
  return cfg;
}

// ---- EdgeGrid EG1-HMAC-SHA256 signing --------------------------------------

function base64HmacSha256(data, key) {
  return createHmac('sha256', key).update(data, 'utf8').digest('base64');
}

function base64Sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('base64');
}

// Akamai timestamp: yyyyMMdd'T'HH:mm:ss+0000 in UTC.
function edgeGridTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+0000`
  );
}

// Build the Authorization header per the EdgeGrid spec. `creds` = {clientToken,
// accessToken, clientSecret}; `req` = {method, host, path, body}. timestamp +
// nonce are injectable for deterministic tests.
function makeAuthHeader(creds, req, timestamp = edgeGridTimestamp(), nonce = randomUUID()) {
  let authHeader =
    `EG1-HMAC-SHA256 client_token=${creds.clientToken};` +
    `access_token=${creds.accessToken};timestamp=${timestamp};nonce=${nonce};`;
  const signingKey = base64HmacSha256(timestamp, creds.clientSecret);
  const contentHash = req.method === 'POST' && req.body ? base64Sha256(req.body) : '';
  const dataToSign = [
    req.method.toUpperCase(),
    'https',
    req.host.toLowerCase(),
    req.path,
    '', // canonicalized request headers — none signed
    contentHash,
    authHeader,
  ].join('\t');
  const signature = base64HmacSha256(dataToSign, signingKey);
  return `${authHeader}signature=${signature}`;
}

// Parse + validate the JSON credential bundle from Credential Store. Returns
// null (never throws) when absent/malformed — the caller fails open.
function parseCreds(raw) {
  if (!raw) return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  const host = obj.host;
  const clientToken = obj.client_token;
  const clientSecret = obj.client_secret;
  const accessToken = obj.access_token;
  if (!host || !clientToken || !clientSecret || !accessToken) return null;
  return { host, clientToken, clientSecret, accessToken };
}

// Test seam: allow a mock fetch/credential without touching credstore or the
// network. Pinned to globalThis for the CDS+Vitest module-multiplicity reason.
const TEST_KEY = Symbol.for('com.sap.developers.ims:fast-purge-testhooks');
const _test = (globalThis[TEST_KEY] ??= { fetchImpl: null });

/**
 * Purge a set of Edge-Cache-Tag values via Akamai Fast-Purge (CCU v3).
 * Awaitable core used by tests and by the fire-and-forget wrappers. NEVER
 * throws. Returns a small result object describing what happened.
 *
 * @param {string[]} tags
 * @returns {Promise<{ok:boolean, skipped?:string, status?:number, purged?:number}>}
 */
export async function purgeTags(tags) {
  try {
    if (!isFlagEnabled('EDGE_PURGE_ENABLED')) return { ok: true, skipped: 'flag-off' };
    const unique = [...new Set((tags || []).filter((t) => typeof t === 'string' && t))];
    if (!unique.length) return { ok: true, skipped: 'no-tags' };

    const raw = await resolveSecret(SECRET_ALIAS, { logTag: '[fast-purge]' });
    const creds = parseCreds(raw);
    if (!creds) {
      LOG.warn('EDGE_PURGE_ENABLED is on but no valid Akamai credential is configured — skipping purge (fail-open)');
      return { ok: false, skipped: 'no-credential' };
    }

    const cfg = await resolveConfig();
    const fetchImpl = _test.fetchImpl || fetch;
    let purged = 0;
    let lastStatus = 0;
    for (let i = 0; i < unique.length; i += MAX_TAGS_PER_CALL) {
      const batch = unique.slice(i, i + MAX_TAGS_PER_CALL);
      const path = `/ccu/v3/invalidate/tag/${cfg.network}`;
      const body = JSON.stringify({ objects: batch });
      const auth = makeAuthHeader(
        creds,
        { method: 'POST', host: creds.host, path, body }
      );
      const res = await fetchImpl(`https://${creds.host}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      lastStatus = res.status;
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        LOG.warn(`Fast-Purge returned ${res.status} for ${batch.length} tag(s): ${detail.slice(0, 200)}`);
        counter('edgepurge.failed');
        return { ok: false, status: res.status, purged };
      }
      purged += batch.length;
    }
    counter('edgepurge.purged');
    LOG.info(`Fast-Purge invalidated ${purged} tag(s) on ${cfg.network}`);
    return { ok: true, status: lastStatus, purged };
  } catch (err) {
    LOG.warn(`Fast-Purge failed (allowing content change to proceed): ${err.message}`);
    counter('edgepurge.failed');
    return { ok: false, skipped: 'error' };
  }
}

// Map a set of freshly published slugs to their per-item Edge-Cache-Tag set,
// dropping the coarse corpus/category tags so a targeted publish purges only
// the changed items (not the whole edge cache).
function itemTagsForSlugs(slugs) {
  const tags = new Set();
  for (const slug of slugs || []) {
    for (const t of cacheTagsFor(slug)) {
      if (!COARSE_TAGS.has(t)) tags.add(t);
    }
  }
  return [...tags];
}

/**
 * Fire-and-forget: purge the edge for the freshly published slugs. Void —
 * returns immediately, never awaited from the commit path. Call after the
 * in-process cache invalidate in commitHandler.
 */
export function purgePublishedSlugs(slugs) {
  const tags = itemTagsForSlugs(slugs);
  if (!tags.length) return;
  Promise.resolve(purgeTags(tags)).catch(() => {});
}

/**
 * Fire-and-forget: purge the entire content corpus (coarse `content` tag). Used
 * on rollback, where only a manifest version — not a per-slug list — is known.
 */
export function purgeAllContent() {
  Promise.resolve(purgeTags(['content'])).catch(() => {});
}

// ---- test-only hooks -------------------------------------------------------
export const _makeAuthHeaderForTest = makeAuthHeader;
export const _edgeGridTimestampForTest = edgeGridTimestamp;
export const _itemTagsForSlugsForTest = itemTagsForSlugs;
export function _setFetchForTest(fn) {
  _test.fetchImpl = fn;
}
export function _resetForTest() {
  _test.fetchImpl = null;
  _cfgState.cached = null;
  _cfgState.cachedAt = 0;
}
