// srv/lib/runtime-config/tenant-settings.js
// Resolves the tenant-wide config bag: CORS origins, rebuild target env,
// tech-user JSON config, tech-user mapping. Special-shape fields stored
// as raw String/LargeString — consumers keep their existing parse logic.

import cds from '@sap/cds';

const LOG = cds.log('tenant-settings-resolver');

const TTL_MS = 5_000;
// Cache stored on globalThis so module-singleton multiplicity (Vitest+CDS
// on Windows) doesn't produce divergent caches across instances.
const STATE_KEY = Symbol.for('com.sap.developers.ims:tenant-settings-resolver');
const _state = (globalThis[STATE_KEY] ??= { cached: null, cachedAt: 0 });

const DEFAULTS = {
  allowedCorsOrigins: 'http://localhost:1313,http://localhost:5000,http://localhost:4004',
  rebuildTargetEnv: 'dev',
  techUsers: '',
  techUsersMapping: '',
};

async function readRow() {
  try {
    const { TenantSettings } = cds.entities('com.sap.developers.ims');
    return (await SELECT.one.from(TenantSettings)) ?? null;
  } catch (capErr) {
    try {
      const db = await cds.connect.to('db');
      const rows = await db.run(
        'SELECT allowedCorsOrigins, rebuildTargetEnv, techUsers, techUsersMapping ' +
        'FROM COM_SAP_DEVELOPERS_IMS_TENANTSETTINGS LIMIT 1'
      );
      return rows?.[0] ?? null;
    } catch (sqlErr) {
      LOG.warn('TenantSettings read failed; using env-var defaults', sqlErr.message);
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

function envString(name) {
  const v = process.env[name];
  return v === undefined || v === '' ? null : v;
}

export async function resolveTenantSettings() {
  const now = Date.now();
  if (_state.cached && (now - _state.cachedAt) < TTL_MS) return _state.cached;

  const row = await readRow();
  const settings = {
    allowedCorsOrigins:
      pick(row, 'allowedCorsOrigins', 'ALLOWEDCORSORIGINS')
      ?? envString('ALLOWED_CORS_ORIGINS')
      ?? DEFAULTS.allowedCorsOrigins,
    rebuildTargetEnv:
      pick(row, 'rebuildTargetEnv', 'REBUILDTARGETENV')
      ?? envString('REBUILD_TARGET_ENV')
      ?? DEFAULTS.rebuildTargetEnv,
    techUsers:
      pick(row, 'techUsers', 'TECHUSERS')
      ?? envString('TECH_USERS')
      ?? DEFAULTS.techUsers,
    techUsersMapping:
      pick(row, 'techUsersMapping', 'TECHUSERSMAPPING')
      ?? envString('TECH_USERS_MAPPING')
      ?? DEFAULTS.techUsersMapping,
  };

  _state.cached = settings;
  _state.cachedAt = now;
  return settings;
}

export function _resetCacheForTests() {
  _state.cached = null;
  _state.cachedAt = 0;
}
