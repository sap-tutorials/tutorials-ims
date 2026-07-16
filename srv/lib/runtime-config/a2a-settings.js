// srv/lib/runtime-config/a2a-settings.js
// Resolves A2A endpoint config from the ChatSettings singleton. DB → hardcoded
// default (no env layer — #1220's A2A_* env vars were removed in this change).
// Mirrors srv/lib/runtime-config/kg-settings.js (DB→default, 5s cache). The
// card handler + rpc-router kill-switch are per-request hot paths, hence cache.
import cds from '@sap/cds';

const LOG = cds.log('a2a-settings-resolver');
const TTL_MS = 5_000;
let _cachedAt = 0;
let _cached = null;

const DEFAULTS = { enabled: true, publicBaseUrl: '', tokenUrl: '' };

async function readRow() {
  try {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    return (await SELECT.one.from(ChatSettings)) ?? null;
  } catch (capErr) {
    try {
      const db = await cds.connect.to('db');
      const rows = await db.run(
        'SELECT a2aEnabled, a2aPublicBaseUrl, a2aTokenUrl ' +
        'FROM COM_SAP_DEVELOPERS_IMS_CHATSETTINGS LIMIT 1'
      );
      return rows?.[0] ?? null;
    } catch (sqlErr) {
      LOG.warn('ChatSettings read failed; using A2A defaults', sqlErr.message);
      return null;
    }
  }
}

function pick(row, lower, UPPER) {
  if (!row) return undefined;
  return row[lower] !== undefined ? row[lower] : row[UPPER];
}

export function _resetA2aSettingsCache() { _cachedAt = 0; _cached = null; }

export async function resolveA2aSettings() {
  const now = Date.now();
  if (_cached && now - _cachedAt < TTL_MS) return _cached;

  const row = await readRow();
  const enabledRaw = pick(row, 'a2aEnabled', 'A2AENABLED');
  const baseRaw    = pick(row, 'a2aPublicBaseUrl', 'A2APUBLICBASEURL');
  const tokenRaw   = pick(row, 'a2aTokenUrl', 'A2ATOKENURL');

  _cached = {
    enabled: enabledRaw == null ? DEFAULTS.enabled : !!enabledRaw,
    publicBaseUrl: baseRaw || DEFAULTS.publicBaseUrl,
    tokenUrl: tokenRaw || DEFAULTS.tokenUrl,
  };
  _cachedAt = now;
  return _cached;
}
