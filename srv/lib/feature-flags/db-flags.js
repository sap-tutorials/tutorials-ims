// srv/lib/feature-flags/db-flags.js
//
// Generic, registry-driven ImsConfig-backed feature-flag resolver (issue #2060).
// Moves the remaining on/off `kind:'env'` feature flags out of process.env and
// into the ImsConfig key/value table (Tom prefers DB-driven admin config over
// env vars). Mirrors the cached-DB-flag pattern established by
// srv/lib/content-delta-flags.js, but generalized: the set of managed flags and
// their per-flag defaults are read from srv/lib/feature-flags/registry.js — any
// `kind:'db'` + `valueType:'boolean'` entry with an `imsConfigKey` is managed
// here, so adding a new DB boolean flag needs no change to this file.
//
// EXCEPTION: the Content Option-B delta flags (imsConfigKey content.delta.*)
// keep their OWN dedicated module (content-delta-flags.js) — they seed to TRUE
// (fast-path-ON) rather than to their declared registry default, and they carry
// bespoke synchronous hot-path getters. To avoid a double-seed / double-cache
// conflict they are explicitly excluded from this generic manager.
//
// Contract (mirrors content-delta-flags.js):
//   - isFlagEnabled(registryKey) is SYNCHRONOUS. It returns the last-known
//     cached boolean; when the cache is cold or stale it kicks off a
//     fire-and-forget background refresh and returns the current value.
//   - Fail-safe on a COLD cache or a DB read error is the flag's DECLARED
//     registry default (NOT a blanket false) — so a `false-disables` kill
//     switch stays ON (true) through a DB hiccup, and a `true-enables` flag
//     stays OFF (false). Never blocks, never throws.

import cds from '@sap/cds';
import { FEATURE_FLAGS } from './registry.js';

const LOG = cds.log('feature-flags');
const NS = 'com.sap.developers.ims';

// 60s TTL — an admin toggle takes effect within a minute even without an
// explicit bust (matches the content-delta + ngds-autosend + alert windows).
export const FLAG_TTL_MS = 60 * 1000;

// ImsConfig keys owned by the dedicated content-delta-flags.js module — never
// managed (seeded/cached) here. See the header note.
const EXCLUDED_IMS_KEYS = new Set([
  'content.delta.write',
  'content.delta.read',
  'content.delta.skipCarryForward',
]);

// Static map built once from the registry: registryKey -> { imsConfigKey,
// default:boolean }. The source of truth is registry.js.
const DB_FLAGS = new Map();
for (const f of FEATURE_FLAGS) {
  if (
    f.kind === 'db' &&
    f.valueType === 'boolean' &&
    f.imsConfigKey &&
    !EXCLUDED_IMS_KEYS.has(f.imsConfigKey)
  ) {
    DB_FLAGS.set(f.key, { imsConfigKey: f.imsConfigKey, default: Boolean(f.default) });
  }
}

// All ImsConfig keys this module manages — one SELECT covers them all.
const ALL_IMS_KEYS = [...DB_FLAGS.values()].map((m) => m.imsConfigKey);

// Warm cache + refresh guard live on globalThis so EVERY module instance shares
// one cache. CAP loads service modules via a dynamic file:// import whose URL
// can differ from a static import's (e.g. Windows drive-letter case), yielding
// separate ESM instances of this file; a module-local `let` cache would then be
// per-instance (a service and its test, or two services, would not see each
// other's toggles). Keying the state on globalThis (same pattern as the
// __metricsDbWrapInstalled sentinel in server.js) makes the flag cache process-
// global. `at === 0` means never-loaded → every getter reports the per-flag
// declared default and triggers a background refresh; `values` maps
// imsConfigKey -> boolean (an absent key also falls back to the declared default).
const STATE = (globalThis.__imsFeatureFlagsState__ ??= {
  values: Object.create(null),
  at: 0,
  refreshing: null,
});

function isFresh() {
  return STATE.at !== 0 && Date.now() - STATE.at < FLAG_TTL_MS;
}

/** Fire-and-forget background refresh, deduplicated. Never throws. */
function scheduleRefresh() {
  if (STATE.refreshing) return;
  STATE.refreshing = refreshFeatureFlags()
    .catch(() => {})
    .finally(() => { STATE.refreshing = null; });
}

/**
 * Reload every managed flag from ImsConfig in ONE SELECT and update the cache +
 * timestamp. Fail-safe: on ANY DB error the last-known cache values are kept (a
 * warm cache is never clobbered by a transient fault) and only the timestamp is
 * bumped so a burst of getters during an outage doesn't schedule a refresh
 * storm. On a cold cache a fault leaves `values` empty → every getter returns
 * its declared default.
 *
 * @returns {Promise<Record<string, boolean>>} imsConfigKey -> boolean
 */
export async function refreshFeatureFlags() {
  try {
    const db = await cds.connect.to('db');
    const { ImsConfig } = cds.entities(NS);
    const rows = await db.run(
      SELECT.from(ImsConfig).columns('key', 'value').where({ key: { in: ALL_IMS_KEYS } })
    );
    const values = Object.create(null);
    for (const r of rows || []) values[r.key] = String(r.value).toLowerCase() === 'true';
    STATE.values = values;
    STATE.at = Date.now();
  } catch (err) {
    LOG.warn('feature flag refresh failed; keeping last-known values:', err.message);
    STATE.at = Date.now();
  }
  return { ...STATE.values };
}

/**
 * Drop the cache so the next getter (and any explicit refresh) re-reads the DB.
 * Called by the admin toggle so a flip takes effect immediately rather than
 * after the TTL window.
 */
export function bustFeatureFlagsCache() {
  STATE.values = Object.create(null);
  STATE.at = 0;
  STATE.refreshing = null;
}

/**
 * Seed any ABSENT managed imsConfigKey with its registry default ('true' /
 * 'false'). Run once on boot BEFORE the warm refresh so the DB carries an
 * explicit row for every flag and the effective value is durable across deploys
 * (data, not env — env vars were discarded by the blue-green swap).
 *
 * Only INSERTs missing keys — a key an admin already set (true OR false) has a
 * row this leaves untouched, so a deliberate override survives deploys.
 * ImsConfig is `cuid`, so set ID explicitly (a raw db.run INSERT does not
 * auto-fill the UUID key on HANA — cds-db-insert-omitting-uuid-key gotcha).
 * Fail-open: never throws into boot.
 *
 * @returns {Promise<string[]>} the imsConfigKeys that were seeded (empty if all present)
 */
export async function ensureFeatureFlagDefaults() {
  try {
    const db = await cds.connect.to('db');
    const { ImsConfig } = cds.entities(NS);
    const rows = await db.run(
      SELECT.from(ImsConfig).columns('key').where({ key: { in: ALL_IMS_KEYS } })
    );
    const present = new Set((rows || []).map((r) => r.key));
    const missing = [...DB_FLAGS.values()].filter((m) => !present.has(m.imsConfigKey));
    if (missing.length) {
      await db.run(
        INSERT.into(ImsConfig).entries(
          missing.map((m) => ({ ID: cds.utils.uuid(), key: m.imsConfigKey, value: String(m.default) }))
        )
      );
      LOG.info(
        `seeded defaults for absent feature flags: ${missing.map((m) => m.imsConfigKey).join(', ')}`
      );
    }
    return missing.map((m) => m.imsConfigKey);
  } catch (err) {
    LOG.warn('feature-flag default seed failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * SYNCHRONOUS effective boolean for a managed feature flag, keyed by its
 * REGISTRY key (e.g. 'METRICS_ENABLED', 'KG_PAGERANK_ENABLED'). Returns the
 * cached value; when the cache is cold/stale it kicks off a non-blocking
 * background refresh and returns the current value. Fail-safe (cold cache, DB
 * error, or unset DB row) is the flag's DECLARED registry default. Never blocks,
 * never throws.
 *
 * @param {string} registryKey
 * @returns {boolean}
 */
export function isFlagEnabled(registryKey) {
  const meta = DB_FLAGS.get(registryKey);
  if (!meta) {
    // Not a managed DB boolean flag — defensive, should not happen in practice.
    LOG.warn(`isFlagEnabled: unknown feature flag '${registryKey}' — returning false`);
    return false;
  }
  if (!isFresh()) scheduleRefresh();
  const v = STATE.values[meta.imsConfigKey];
  return v === undefined ? meta.default : v === true;
}

// Test/introspection helper — the registry keys this module manages.
export function managedFlagKeys() {
  return [...DB_FLAGS.keys()];
}

// Metadata for one managed flag by its registry key, or null if unmanaged.
// Used by the AdminService setFeatureFlag/getFeatureFlags actions.
export function flagMeta(registryKey) {
  const m = DB_FLAGS.get(registryKey);
  return m ? { imsConfigKey: m.imsConfigKey, default: m.default } : null;
}

// Test-only: force a flag's cached value (and mark the cache fresh) without a
// DB round-trip, so a unit test can toggle a kill switch deterministically.
// NOT for production use.
export function __setFlagForTest(registryKey, enabled) {
  const meta = DB_FLAGS.get(registryKey);
  if (!meta) return;
  STATE.values[meta.imsConfigKey] = Boolean(enabled);
  STATE.at = Date.now();
}

// Test-only: clear any forced cache state back to cold (every flag reads its
// declared default until the next refresh).
export function __resetFlagsForTest() {
  bustFeatureFlagsCache();
}
