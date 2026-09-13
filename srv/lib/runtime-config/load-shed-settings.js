// srv/lib/runtime-config/load-shed-settings.js
// Numeric threshold config for the origin-side load-shedding guard (PR4,
// #2271). Mirrors rate-limit-settings.js: DB-backed (ImsConfig key/value),
// ~5s cache, globalThis-pinned, never throws, NO env-var fallback (project
// rule: tunable behavior lives in the DB, toggled live in the admin UI — env
// vars are dropped by the blue-green swap).
//
// The master on/off is a separate feature flag (LOADSHED_ENABLED, ImsConfig
// flag.loadshed) resolved by srv/lib/feature-flags/db-flags.js. THIS module
// only supplies the numbers once the guard is on. Any unset / malformed key
// falls back to its hardcoded default, so a partial config never disables
// protection.

import cds from '@sap/cds';

const LOG = cds.log('load-shed-settings');
const NS = 'com.sap.developers.ims';
const TTL_MS = 5_000;

const STATE_KEY = Symbol.for('com.sap.developers.ims:load-shed-settings-resolver');
const _state = (globalThis[STATE_KEY] ??= { cached: null, cachedAt: 0 });

// maxConcurrent — the ceiling on simultaneous in-flight DB content reads on the
// anonymous serve path before excess requests are shed. Chosen well above
// normal browsing concurrency (a warm cache never reaches the guard) but low
// enough to bound the blast radius of a scraper flood that gets past the edge
// cache — the per-request gzip-BLOB read + gunzip is the known OOM-sensitive
// hot path with no static fallback. retryAfterSeconds — the Retry-After hint on
// a 503 shed. Both overridable per env via ImsConfig.
export const DEFAULT_CONFIG = Object.freeze({
  maxConcurrent: 64,
  retryAfterSeconds: 2,
});

// ImsConfig key -> path into the config object.
const KEY_MAP = {
  'loadshed.maxConcurrent': ['maxConcurrent'],
  'loadshed.retryAfterSeconds': ['retryAfterSeconds'],
};
const ALL_KEYS = Object.keys(KEY_MAP);

function freshClone() {
  return { ...DEFAULT_CONFIG };
}

function applyRow(cfg, key, value) {
  const path = KEY_MAP[key];
  if (!path) return;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return; // reject unset/garbage/zero → keep default
  cfg[path[0]] = n;
}

/**
 * Resolve the effective numeric config. NEVER throws; on any read failure the
 * hardcoded defaults are returned. Cached ~5s.
 * @returns {Promise<{maxConcurrent:number, retryAfterSeconds:number}>}
 */
export async function resolveLoadShedConfig() {
  const now = Date.now();
  if (_state.cached && now - _state.cachedAt < TTL_MS) return _state.cached;

  const cfg = freshClone();
  try {
    if (typeof cds.entities === 'function') {
      const db = await cds.connect.to('db');
      const { ImsConfig } = cds.entities(NS);
      const rows = await db.run(
        SELECT.from(ImsConfig).columns('key', 'value').where({ key: { in: ALL_KEYS } })
      );
      for (const r of rows || []) applyRow(cfg, r.key, r.value);
    }
  } catch (err) {
    LOG.warn(`config read failed; using defaults: ${err.message}`);
  }

  _state.cached = cfg;
  _state.cachedAt = now;
  return cfg;
}

/** Test-only: clear the memoised config between cases. */
export function _resetForTest() {
  _state.cached = null;
  _state.cachedAt = 0;
}

/** Test-only: prime the cache with a known config (skips the DB read). */
export function _primeForTest(cfg) {
  _state.cached = { ...DEFAULT_CONFIG, ...cfg };
  _state.cachedAt = Date.now();
}
