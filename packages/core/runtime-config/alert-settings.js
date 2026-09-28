// srv/lib/runtime-config/alert-settings.js
// Resolves whether operational alerting (srv/lib/alerting.js → SAP Alert
// Notification) is enabled.
//
// CHAIN: DB row (ChatSettings.alertsEnabled) -> hardcoded default `false`.
// NO env-var fallback (deliberate — project rule: tunable behavior is
// DB-backed + admin-editable, never `process.env`). The admin UI at
// /admin-ui/#joule is the sole source of truth; an env var would create a
// silent-shadow bug where a stale `cf set-env` masks a fresh admin write
// until the next restart. Default `false` = alerting dark until an admin
// flips it live.

import cds from '@sap/cds';

const LOG = cds.log('alert-settings-resolver');

const TTL_MS = 5_000;
// globalThis-pinned cache so module-singleton multiplicity (Vitest+CDS on
// Windows) doesn't diverge across instances — same pattern as the sibling
// runtime-config resolvers.
const STATE_KEY = Symbol.for('com.sap.developers.ims:alert-settings-resolver');
const _state = (globalThis[STATE_KEY] ??= { cached: null, cachedAt: 0 });

const DEFAULT_ENABLED = false;

async function readRow () {
  try {
    if (typeof cds.entities === 'function') {
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      return (await SELECT.one.from(ChatSettings)) ?? null;
    }
    // Build-pipeline path: cds.entities not initialized. Raw SQL returns
    // UPPERCASE column names on HANA — pick() handles both cases.
    const db = await cds.connect.to('db');
    const rows = await db.run(
      'SELECT alertsEnabled FROM COM_SAP_DEVELOPERS_IMS_CHATSETTINGS LIMIT 1'
    );
    return rows?.[0] ?? null;
  } catch (err) {
    LOG.warn('ChatSettings read failed; alerting defaults to disabled', err.message);
    return null;
  }
}

function pickBool (row, lower, upper) {
  if (row == null) return null;
  const v = row[lower];
  if (v !== undefined && v !== null) return v;
  const u = row[upper];
  return u !== undefined && u !== null ? u : null;
}

// Returns true only when the admin has explicitly enabled alerting in the DB.
// Any read failure or missing row → DEFAULT_ENABLED (false). Never throws.
export async function isAlertingEnabled () {
  const now = Date.now();
  if (_state.cached !== null && (now - _state.cachedAt) < TTL_MS) return _state.cached;

  const row = await readRow();
  const raw = pickBool(row, 'alertsEnabled', 'ALERTSENABLED');
  const enabled = raw === null ? DEFAULT_ENABLED : Boolean(raw);

  _state.cached = enabled;
  _state.cachedAt = now;
  return enabled;
}

// Test-only: clear the memoised value between cases.
export function _resetForTest () {
  _state.cached = null;
  _state.cachedAt = 0;
}
