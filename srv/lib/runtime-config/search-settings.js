// srv/lib/runtime-config/search-settings.js
// Resolves the /search/* per-IP rate-limit knobs. Layered precedence:
//   1. SearchSettings row via cds.entities
//   2. Raw-SQL UPPERCASE fallback for build-pipeline contexts
//   3. process.env.SEARCH_RATE_LIMIT_MAX / SEARCH_RATE_LIMIT_WINDOW_MS
//   4. Hardcoded defaults: rateLimitMax=60, rateLimitWindowMs=60000

import cds from '@sap/cds';

const LOG = cds.log('search-settings-resolver');

const TTL_MS = 5_000;
let _cachedAt = 0;
let _cached = null;

const DEFAULTS = {
  rateLimitMax: 60,
  rateLimitWindowMs: 60_000,
};

async function readRow() {
  try {
    const { SearchSettings } = cds.entities('com.sap.developers.ims');
    return (await SELECT.one.from(SearchSettings)) ?? null;
  } catch (capErr) {
    try {
      const db = await cds.connect.to('db');
      const rows = await db.run(
        'SELECT rateLimitMax, rateLimitWindowMs FROM COM_SAP_DEVELOPERS_IMS_SEARCHSETTINGS LIMIT 1'
      );
      return rows?.[0] ?? null;
    } catch (sqlErr) {
      LOG.warn('SearchSettings read failed; using env-var defaults', sqlErr.message);
      return null;
    }
  }
}

function pick(row, lower, upper) {
  if (row == null) return null;
  const v = row[lower];
  if (v !== undefined && v !== null) return v;
  const u = row[upper];
  return u !== undefined && u !== null ? u : null;
}

function envNumber(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function resolveSearchSettings() {
  const now = Date.now();
  if (_cached && (now - _cachedAt) < TTL_MS) return _cached;

  const row = await readRow();
  const settings = {
    rateLimitMax:
      pick(row, 'rateLimitMax', 'RATELIMITMAX')
      ?? envNumber('SEARCH_RATE_LIMIT_MAX')
      ?? DEFAULTS.rateLimitMax,
    rateLimitWindowMs:
      pick(row, 'rateLimitWindowMs', 'RATELIMITWINDOWMS')
      ?? envNumber('SEARCH_RATE_LIMIT_WINDOW_MS')
      ?? DEFAULTS.rateLimitWindowMs,
  };

  _cached = settings;
  _cachedAt = now;
  return settings;
}

export function _resetCacheForTests() {
  _cached = null;
  _cachedAt = 0;
}
