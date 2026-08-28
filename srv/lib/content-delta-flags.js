// srv/lib/content-delta-flags.js
//
// Workstream D Option-B feature flags, moved from process.env.* to DB config in
// the ImsConfig key/value table (Tom prefers DB-driven admin config over env
// vars). Three flags gate the migration off the legacy ContentFiles snapshot
// model onto the mutable ContentCurrent model, flipped in order:
//
//   content.delta.write            (CONTENT_DELTA_WRITE_ENABLED)
//   content.delta.read             (CONTENT_DELTA_READ_ENABLED)
//   content.delta.skipCarryForward (CONTENT_DELTA_SKIP_CARRYFORWARD)
//
// This is a PROD content-serving hot path: `resolveContentBlob` and the serve
// handlers consult isDeltaRead() on every request. The getters are therefore
// SYNCHRONOUS and NEVER block or throw — they return the last-known cached
// boolean and (when stale) kick off a fire-and-forget background refresh.
//
// Fail-safe default is FALSE (the legacy ContentFiles path) so a cold cache or
// any DB read error never silently enables delta reads/writes. Mirrors the
// cached-DB-flag pattern in ngds-autosend.js.

import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';

// ImsConfig keys (string values, 'true'/'false').
export const DELTA_WRITE_KEY = 'content.delta.write';
export const DELTA_READ_KEY = 'content.delta.read';
export const DELTA_SKIP_CARRYFORWARD_KEY = 'content.delta.skipCarryForward';

const ALL_KEYS = [DELTA_WRITE_KEY, DELTA_READ_KEY, DELTA_SKIP_CARRYFORWARD_KEY];

// 60s TTL: short enough that an admin toggle takes effect within a minute even
// without an explicit cache bust (matches the ngds-autosend + alert windows).
export const FLAG_TTL_MS = 60 * 1000;

// A single warm cache object refreshed together (one SELECT of the 3 keys).
// `at === 0` means never-loaded → every getter reports the fail-safe default
// (false) and triggers a background refresh.
let _cache = {
  write: false,
  read: false,
  skipCarryForward: false,
  at: 0,
};

// Guards against stacking concurrent background refreshes when many hot-path
// getters observe a stale cache in the same tick.
let _refreshing = null;

function isFresh() {
  return _cache.at !== 0 && Date.now() - _cache.at < FLAG_TTL_MS;
}

/**
 * Fire-and-forget background refresh, deduplicated. Never throws.
 */
function scheduleRefresh() {
  if (_refreshing) return;
  _refreshing = refreshContentDeltaFlags()
    .catch(() => {})
    .finally(() => { _refreshing = null; });
}

/**
 * Reload all three flags from ImsConfig in a single SELECT and update the cache
 * + timestamp. Fail-safe: on ANY DB error, the last-known cache values are kept
 * (a warm cache is never clobbered by a transient fault) and only the timestamp
 * is refreshed so we don't hammer the DB on every getter during an outage.
 * On a cold cache (never loaded) a fault leaves the safe defaults (all false).
 *
 * @returns {Promise<{write:boolean,read:boolean,skipCarryForward:boolean}>}
 */
export async function refreshContentDeltaFlags() {
  try {
    const db = await cds.connect.to('db');
    const { ImsConfig } = cds.entities(NS);
    const rows = await db.run(
      SELECT.from(ImsConfig).columns('key', 'value').where({ key: { in: ALL_KEYS } })
    );
    const byKey = Object.create(null);
    for (const r of rows || []) byKey[r.key] = String(r.value).toLowerCase() === 'true';
    _cache = {
      write: byKey[DELTA_WRITE_KEY] === true,
      read: byKey[DELTA_READ_KEY] === true,
      skipCarryForward: byKey[DELTA_SKIP_CARRYFORWARD_KEY] === true,
      at: Date.now(),
    };
  } catch (err) {
    // Keep last-known values; do not fail the caller. Bump the timestamp so a
    // burst of getters during a DB hiccup doesn't schedule a refresh storm.
    cds.log('content-delta-flags').warn(
      'content delta flag refresh failed; keeping last-known values:',
      err.message
    );
    _cache = { ..._cache, at: Date.now() };
  }
  return { write: _cache.write, read: _cache.read, skipCarryForward: _cache.skipCarryForward };
}

/**
 * Drop the cache so the next getter (and any explicit refresh) re-reads from the
 * DB. Called by the admin toggle so a flip takes effect immediately rather than
 * after the TTL window.
 */
export function bustContentDeltaFlagsCache() {
  _cache = { write: false, read: false, skipCarryForward: false, at: 0 };
  _refreshing = null;
}

// --- Synchronous hot-path getters -----------------------------------------
// Each returns the last-known boolean immediately. When the cache is stale (or
// cold) it kicks off a non-blocking background refresh and returns the CURRENT
// cached value. They never await and never throw.

function readSync(field) {
  if (!isFresh()) scheduleRefresh();
  return _cache[field] === true;
}

export function isDeltaWrite() {
  return readSync('write');
}

export function isDeltaRead() {
  return readSync('read');
}

export function isDeltaSkipCarryForward() {
  return readSync('skipCarryForward');
}
