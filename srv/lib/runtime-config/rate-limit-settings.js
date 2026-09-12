// srv/lib/runtime-config/rate-limit-settings.js
// Numeric threshold config for the origin-side rate limiter. Mirrors the
// alert-settings resolver: DB-backed (ImsConfig key/value), ~5s cache,
// globalThis-pinned, never throws, NO env-var fallback (project rule: tunable
// behavior lives in the DB, toggled live in the admin UI — env vars are dropped
// by the blue-green swap).
//
// The master on/off is a separate feature flag (RATE_LIMIT_ENABLED, ImsConfig
// flag.ratelimit) resolved by srv/lib/feature-flags/db-flags.js. THIS module
// only supplies the numbers once the limiter is on. Any unset / malformed key
// falls back to its hardcoded default, so a partial config never disables
// protection.

import cds from '@sap/cds';

const LOG = cds.log('rate-limit-settings');
const NS = 'com.sap.developers.ims';
const TTL_MS = 5_000;

const STATE_KEY = Symbol.for('com.sap.developers.ims:rate-limit-settings-resolver');
const _state = (globalThis[STATE_KEY] ??= { cached: null, cachedAt: 0 });

// Per-minute request budgets for the ANON tier, by route class. The auth /
// trusted tiers multiply these (tierMult). Chosen generous enough not to bite
// legitimate browsing while capping a scraper flood well below HANA's OOM
// threshold; all overridable per env via ImsConfig.
export const DEFAULT_CONFIG = Object.freeze({
  windowMs: 60_000,
  limits: Object.freeze({
    content: 120, // /content/* — tutorial HTML BLOBs from HANA
    build: 120, // /build/* — catalog / navigator feeds
    page: 120, // /content/pages/* — content pages
    graph: 60, // /graph/* — knowledge-graph queries (expensive)
    search: 60, // /search — matches the legacy ip-rate-limit default
    api: 60, // anon /api/*
    feedback: 30, // /feedback/* — writes
    homepage: 120, // /homepage/*
    agentic: 120, // /mcp/*, /mcp-pat/*, /a2a, /chat/stream, /graphql/public
    default: 120,
  }),
  tierMult: Object.freeze({ anon: 1, auth: 5, trusted: 20 }),
  // Process-wide blocks-per-minute that trips the RateLimitAbuse alert.
  abuseAlertPerMin: 500,
});

// ImsConfig key -> path into the config object. Limit keys are derived from
// DEFAULT_CONFIG.limits so a new route class needs only a defaults entry.
const KEY_MAP = {
  'ratelimit.windowMs': ['windowMs'],
  'ratelimit.tierMult.auth': ['tierMult', 'auth'],
  'ratelimit.tierMult.trusted': ['tierMult', 'trusted'],
  'ratelimit.abuseAlertPerMin': ['abuseAlertPerMin'],
};
for (const rc of Object.keys(DEFAULT_CONFIG.limits)) {
  KEY_MAP[`ratelimit.limit.${rc}`] = ['limits', rc];
}
const ALL_KEYS = Object.keys(KEY_MAP);

function freshClone() {
  return {
    windowMs: DEFAULT_CONFIG.windowMs,
    limits: { ...DEFAULT_CONFIG.limits },
    tierMult: { ...DEFAULT_CONFIG.tierMult },
    abuseAlertPerMin: DEFAULT_CONFIG.abuseAlertPerMin,
  };
}

function applyRow(cfg, key, value) {
  const path = KEY_MAP[key];
  if (!path) return;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return; // reject unset/garbage/zero → keep default
  if (path.length === 1) cfg[path[0]] = n;
  else cfg[path[0]][path[1]] = n;
}

/**
 * Resolve the effective numeric config. NEVER throws; on any read failure the
 * hardcoded defaults are returned. Cached ~5s.
 * @returns {Promise<{windowMs:number, limits:Record<string,number>, tierMult:Record<string,number>, abuseAlertPerMin:number}>}
 */
export async function resolveRateLimitConfig() {
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
