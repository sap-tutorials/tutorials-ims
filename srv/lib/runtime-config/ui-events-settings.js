// srv/lib/runtime-config/ui-events-settings.js
// Resolves the UI-events telemetry feature flag. Layered precedence:
//   1. UiEventsSettings row via cds.entities (CAP runtime path)
//   2. UiEventsSettings raw-SQL UPPERCASE (HANA build-pipeline path)
//   3. process.env.UI_EVENTS_ENABLED
//   4. Hardcoded default: enabled=false
//
// Inspired by srv/lib/chat-settings-resolver.js (#318). 5-second in-module
// cache via Map+timestamp (no npm dep). Self-contained per Phase 3 spec.
//
// Backwards-compatible: with empty DB row, behavior is identical to the
// current process.env.UI_EVENTS_ENABLED reads. Reverting this PR is safe.

import cds from '@sap/cds';

const LOG = cds.log('ui-events-settings-resolver');

const TTL_MS = 5_000;
// Cache stored on globalThis so module-singleton multiplicity (Vitest+CDS
// on Windows) doesn't produce divergent caches across instances.
const STATE_KEY = Symbol.for('com.sap.developers.ims:ui-events-settings-resolver');
const _state = (globalThis[STATE_KEY] ??= { cached: null, cachedAt: 0 });

const DEFAULTS = { enabled: false };

async function readRow() {
  try {
    const { UiEventsSettings } = cds.entities('com.sap.developers.ims');
    return (await SELECT.one.from(UiEventsSettings)) ?? null;
  } catch (capErr) {
    try {
      const db = await cds.connect.to('db');
      const rows = await db.run(
        'SELECT enabled FROM COM_SAP_DEVELOPERS_IMS_UIEVENTSSETTINGS LIMIT 1'
      );
      return rows?.[0] ?? null;
    } catch (sqlErr) {
      LOG.warn('UiEventsSettings read failed; using env-var defaults', sqlErr.message);
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

export async function resolveUiEventsSettings() {
  const now = Date.now();
  if (_state.cached && (now - _state.cachedAt) < TTL_MS) return _state.cached;

  const row = await readRow();
  const settings = {
    enabled: Boolean(
      pick(row, 'enabled', 'ENABLED')
      ?? envFlag('UI_EVENTS_ENABLED')
      ?? DEFAULTS.enabled
    ),
  };

  _state.cached = settings;
  _state.cachedAt = now;
  return settings;
}

export function _resetCacheForTests() {
  _state.cached = null;
  _state.cachedAt = 0;
}
