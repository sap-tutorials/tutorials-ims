// srv/lib/runtime-config/tenant-settings.js
// Resolves the tenant-wide config bag: CORS origins, rebuild target env,
// tech-user JSON config, tech-user mapping. Special-shape fields stored
// as raw String/LargeString — consumers keep their existing parse logic.
//
// CHAIN: DB row -> hardcoded DEFAULTS. NO env-var fallback (deliberately
// removed in the credstore-runtime-config follow-up PR). The admin UI at
// /admin-ui/#tenantsettings-display is the sole source of truth; env vars
// would create a silent-shadow class of bug where a stale `cf set-env`
// could mask a fresh admin-UI write until the next app restart.

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
      LOG.warn('TenantSettings read failed; using hardcoded DEFAULTS', sqlErr.message);
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

export async function resolveTenantSettings() {
  const now = Date.now();
  if (_state.cached && (now - _state.cachedAt) < TTL_MS) return _state.cached;

  const row = await readRow();
  // Loud warning on missing row at PROD/QA: with the env-fallback layer
  // removed, a missing TenantSettings row silently defaults rebuildTargetEnv
  // to 'dev' — which on PROD would mis-route rebuild dispatches to the DEV
  // workflow. The pre-flight in the credstore-runtime-config plan is the
  // primary mitigation; this log is defense in depth if the row gets wiped
  // post-deploy (HDI clobber, admin DELETE, schema drift).
  if (row === null && _state.cached === null) {
    LOG.warn(
      'TenantSettings row absent — using hardcoded DEFAULTS (rebuildTargetEnv=\'dev\'). ' +
      'If this is QA or PROD, dispatches will mis-route to the DEV workflow. ' +
      'Populate via /admin-ui/#tenantsettings-display.',
    );
  }
  const settings = {
    allowedCorsOrigins:
      pick(row, 'allowedCorsOrigins', 'ALLOWEDCORSORIGINS')
      ?? DEFAULTS.allowedCorsOrigins,
    rebuildTargetEnv:
      pick(row, 'rebuildTargetEnv', 'REBUILDTARGETENV')
      ?? DEFAULTS.rebuildTargetEnv,
    techUsers:
      pick(row, 'techUsers', 'TECHUSERS')
      ?? DEFAULTS.techUsers,
    techUsersMapping:
      pick(row, 'techUsersMapping', 'TECHUSERSMAPPING')
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
