// srv/lib/runtime-config/navigator-settings.js
// Resolves the /build/navigator nested-group inclusion flag. Layered:
//   1. NavigatorSettings row → 2. raw-SQL UPPERCASE → 3. env → 4. default false

import cds from '@sap/cds';

const LOG = cds.log('navigator-settings-resolver');

const TTL_MS = 5_000;
let _cachedAt = 0;
let _cached = null;

const DEFAULTS = { includeNestedGroups: false };

async function readRow() {
  try {
    const { NavigatorSettings } = cds.entities('com.sap.developers.ims');
    return (await SELECT.one.from(NavigatorSettings)) ?? null;
  } catch (capErr) {
    try {
      const db = await cds.connect.to('db');
      const rows = await db.run(
        'SELECT includeNestedGroups FROM COM_SAP_DEVELOPERS_IMS_NAVIGATORSETTINGS LIMIT 1'
      );
      return rows?.[0] ?? null;
    } catch (sqlErr) {
      LOG.warn('NavigatorSettings read failed; using env-var defaults', sqlErr.message);
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

function envFlag(name) {
  const v = process.env[name];
  if (v === undefined) return null;
  return v === 'true';
}

export async function resolveNavigatorSettings() {
  const now = Date.now();
  if (_cached && (now - _cachedAt) < TTL_MS) return _cached;

  const row = await readRow();
  const settings = {
    includeNestedGroups: Boolean(
      pick(row, 'includeNestedGroups', 'INCLUDENESTEDGROUPS')
      ?? envFlag('NAV_INCLUDE_NESTED_GROUPS')
      ?? DEFAULTS.includeNestedGroups
    ),
  };

  _cached = settings;
  _cachedAt = now;
  return settings;
}

export function _resetCacheForTests() {
  _cached = null;
  _cachedAt = 0;
}
