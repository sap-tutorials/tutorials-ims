// srv/lib/runtime-config/display-settings.js
// Resolves the dashboard URL used in contributor-notification emails.
// Default falls back to the prod approuter URL — same literal that
// srv/admin-service.js:791 and srv/jobs/scheduler.js:134 used pre-migration.

import cds from '@sap/cds';

const LOG = cds.log('display-settings-resolver');

const TTL_MS = 5_000;
let _cachedAt = 0;
let _cached = null;

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
      LOG.warn('DisplaySettings read failed; using env-var defaults', sqlErr.message);
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

export async function resolveDisplaySettings() {
  const now = Date.now();
  if (_cached && (now - _cachedAt) < TTL_MS) return _cached;

  const row = await readRow();
  const settings = {
    dashboardUrl:
      pick(row, 'dashboardUrl', 'DASHBOARDURL')
      ?? envString('DASHBOARD_URL')
      ?? DEFAULTS.dashboardUrl,
  };

  _cached = settings;
  _cachedAt = now;
  return settings;
}

export function _resetCacheForTests() {
  _cached = null;
  _cachedAt = 0;
}
