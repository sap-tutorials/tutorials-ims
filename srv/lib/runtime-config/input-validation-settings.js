// srv/lib/runtime-config/input-validation-settings.js
// Numeric threshold config for the origin-side input validator (PR3). Mirrors
// rate-limit-settings.js exactly: DB-backed (ImsConfig key/value), ~5s cache,
// globalThis-pinned, never throws, NO env-var fallback (project rule: tunable
// behavior lives in the DB, toggled live in the admin UI — env vars are dropped
// by the blue-green swap).
//
// The master on/off is a separate feature flag (INPUT_VALIDATION_ENABLED,
// ImsConfig flag.inputvalidation) resolved by srv/lib/feature-flags/db-flags.js.
// THIS module only supplies the numbers once the validator is on. Any unset /
// malformed key falls back to its hardcoded default, so a partial config never
// disables protection.

import cds from '@sap/cds';

const LOG = cds.log('input-validation-settings');
const NS = 'com.sap.developers.ims';
const TTL_MS = 5_000;

const STATE_KEY = Symbol.for('com.sap.developers.ims:input-validation-settings-resolver');
const _state = (globalThis[STATE_KEY] ??= { cached: null, cachedAt: 0 });

// Defaults chosen as WAF-equivalent safety valves: generous enough never to bite
// a legitimate GraphQL query or MCP/A2A JSON-RPC envelope, tight enough to reject
// oversized / deeply-nested flood payloads well below a HANA/heap OOM. All
// overridable per env via ImsConfig.
export const DEFAULT_CONFIG = Object.freeze({
  // Max request body size (bytes) on the anon POST surface. 1 MiB — a JSON-RPC
  // or GraphQL body is kilobytes; privileged large writes (/content/publish,
  // /build/repo-catalog) are excluded from this cap in register.js.
  maxBodyBytes: 1_048_576,
  // JSON shape limits (walked post-parse on the anon JSON surface).
  maxJsonDepth: 32, // nesting depth of objects/arrays
  maxJsonKeys: 10_000, // total object keys across the whole body
  maxArrayLen: 50_000, // longest single array
  // GraphQL /graphql/public query-document limits.
  gqlMaxDepth: 12, // selection-set nesting depth
  gqlMaxComplexity: 1_000, // approximate cost = total field selections
});

// ImsConfig key -> path into the config object (all one-level here).
const KEY_MAP = {
  'inputvalidation.maxBodyBytes': ['maxBodyBytes'],
  'inputvalidation.maxJsonDepth': ['maxJsonDepth'],
  'inputvalidation.maxJsonKeys': ['maxJsonKeys'],
  'inputvalidation.maxArrayLen': ['maxArrayLen'],
  'inputvalidation.gql.maxDepth': ['gqlMaxDepth'],
  'inputvalidation.gql.maxComplexity': ['gqlMaxComplexity'],
};
const ALL_KEYS = Object.keys(KEY_MAP);

function freshClone() {
  return { ...DEFAULT_CONFIG };
}

function applyRow(cfg, key, value) {
  const path = KEY_MAP[key];
  if (!path) return;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return; // reject unset/garbage/zero → keep default
  cfg[path[0]] = n;
}

/**
 * Resolve the effective numeric config. NEVER throws; on any read failure the
 * hardcoded defaults are returned. Cached ~5s.
 * @returns {Promise<typeof DEFAULT_CONFIG>}
 */
export async function resolveInputValidationConfig() {
  const now = Date.now();
  if (_state.cached && now - _state.cachedAt < TTL_MS) return _state.cached;

  const cfg = freshClone();
  try {
    if (typeof cds.entities === 'function') {
      const db = await cds.connect.to('db');
      const { ImsConfig } = cds.entities(NS);
      const rows = await db.run(
        SELECT.from(ImsConfig).columns('key', 'value').where({ key: { in: ALL_KEYS } })
      );
      for (const r of rows || []) applyRow(cfg, r.key, r.value);
    }
  } catch (err) {
    LOG.warn(`config read failed; using defaults: ${err.message}`);
  }

  _state.cached = cfg;
  _state.cachedAt = now;
  return cfg;
}

/** Test-only: clear the memoised config between cases. */
export function _resetForTest() {
  _state.cached = null;
  _state.cachedAt = 0;
}
