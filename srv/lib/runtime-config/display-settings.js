// srv/lib/runtime-config/display-settings.js
// Resolves the dashboard URL used in contributor-notification emails.
//
// CHAIN: DB row -> hardcoded DEFAULTS. NO env-var fallback (deliberately
// removed in the credstore-runtime-config follow-up PR). The admin UI at
// /admin-ui/#displaysettings-display is the sole source of truth; env vars
// would create a silent-shadow class of bug where a stale `cf set-env`
// could mask a fresh admin-UI write until the next app restart.
//
// Default falls back to the prod approuter URL — same literal that
// srv/admin-service.js and srv/jobs/scheduler.js used pre-migration.

import cds from '@sap/cds';

const LOG = cds.log('display-settings-resolver');

const TTL_MS = 5_000;
// Cache stored on globalThis so module-singleton multiplicity (Vitest+CDS
// on Windows) doesn't produce divergent caches across instances.
const STATE_KEY = Symbol.for('com.sap.developers.ims:display-settings-resolver');
const _state = (globalThis[STATE_KEY] ??= { cached: null, cachedAt: 0 });

const DEFAULTS = {
  dashboardUrl: 'https://tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/ui/tutorialDashboard',
};

async function readRow() {
  try {
    const { DisplaySettings } = cds.entities('com.sap.developers.ims');
    return (await SELECT.one.from(DisplaySettings)) ?? null;
  } catch (capErr) {
    try {
      const db = await cds.connect.to('db');
      const rows = await db.run(
        'SELECT dashboardUrl FROM COM_SAP_DEVELOPERS_IMS_DISPLAYSETTINGS LIMIT 1'
      );
      return rows?.[0] ?? null;
    } catch (sqlErr) {
      LOG.warn('DisplaySettings read failed; using hardcoded DEFAULTS', sqlErr.message);
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

export async function resolveDisplaySettings() {
  const now = Date.now();
  if (_state.cached && (now - _state.cachedAt) < TTL_MS) return _state.cached;

  const row = await readRow();
  // Loud warning on missing row: with the env-fallback layer removed, a missing
  // DisplaySettings row silently defaults dashboardUrl to the prod-approuter
  // URL — which on a non-prod env would surface the wrong dashboard link in
  // contributor-notification emails. Defense in depth for cold-boot drift.
  if (row === null && _state.cached === null) {
    LOG.warn(
      'DisplaySettings row absent — using hardcoded DEFAULTS (dashboardUrl=prod-approuter). ' +
      'Populate via /admin-ui/#displaysettings-display.',
    );
  }
  const settings = {
    dashboardUrl:
      pick(row, 'dashboardUrl', 'DASHBOARDURL')
      ?? DEFAULTS.dashboardUrl,
  };

  _state.cached = settings;
  _state.cachedAt = now;
  return settings;
}

export function _resetCacheForTests() {
  _state.cached = null;
  _state.cachedAt = 0;
}
