// srv/lib/secret-resolver.js
//
// Shared credstore-first secret resolver. Consolidates the
// "BTP Credential Store → process.env → in-memory TTL cache" pattern
// that previously lived inline in srv/lib/rebuild-trigger.js and
// srv/lib/mail-client.js, and extends it to the SUBMISSION_SALT_SECRET
// and CONTENT_API_KEY paths (PR follow-up to #592).
//
// Why a shared module:
// 1) Avoid bug drift — six near-identical inline implementations would
//    have to be kept in sync (warn-once windows, cache invalidation hooks,
//    fallback policy, etc.). Centralizing means one fix lands everywhere.
// 2) Symmetric admin-UI behavior — saving a value at /admin-ui/#secrets-display
//    should take effect on the next cache miss (or immediately for hot-flush
//    callers) regardless of which secret was rotated.
// 3) Unit-test ergonomics — one `_resetForTests()` + one mock surface,
//    instead of N module-level globals.
//
// Module-singleton multiplicity defense via globalThis Symbol — same pattern
// as srv/lib/credstore.js + srv/lib/mail-client.js. See the
// [feedback_module_singletons_in_vitest_cds] memory.

const DEFAULT_TTL_MS = 5 * 60 * 1000;

const STATE_KEY = Symbol.for('com.sap.developers.ims:secret-resolver');
const _state = (globalThis[STATE_KEY] ??= {
  // Map<alias, { value: string|null, expiresAt: number, warnedWindowAt: number }>
  cache: new Map(),
});

function entryFor(alias) {
  let entry = _state.cache.get(alias);
  if (!entry) {
    entry = { value: null, expiresAt: 0, warnedWindowAt: 0 };
    _state.cache.set(alias, entry);
  }
  return entry;
}

/**
 * Resolve a secret value by alias.
 *
 * Resolution order:
 *   1) In-memory cache (TTL = `opts.ttlMs` or 5 minutes)
 *   2) BTP Credential Store (via srv/lib/credstore.js readSecret)
 *   3) process.env[alias]
 *   4) null
 *
 * Credstore errors (binding missing, network blip, JWE decrypt failure)
 * are NOT thrown — they're warned once per TTL window per alias, then
 * the env fallback is tried. This matches the pre-existing behavior of
 * rebuild-trigger.js and mail-client.js so existing operational expectations
 * carry forward (admin UI saves visibly fail loudly on the credstore side
 * — see admin-service.js — but runtime READ failures degrade to env).
 *
 * @param {string} alias — credstore alias = env-var name (we use the same string for both)
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] — cache TTL, default 5 min
 * @param {string} [opts.logTag] — prefix for the one-shot warning ("[rebuild-trigger]" etc.)
 * @returns {Promise<string|null>}
 */
export async function resolveSecret(alias, opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const logTag = opts.logTag ?? '[secret-resolver]';
  const entry = entryFor(alias);

  if (entry.value && Date.now() < entry.expiresAt) {
    return entry.value;
  }

  let value = null;
  try {
    // Dynamic import: credstore.js touches @sap/xsenv at import-time which
    // in some unit-test paths (no binding present) is fine but adds boot
    // latency we don't need to pay if the secret is unused. Existing
    // rebuild-trigger.js / mail-client.js do exactly this.
    const { readSecret } = await import('./credstore.js');
    value = await readSecret(alias);
  } catch (err) {
    const now = Date.now();
    if (now - entry.warnedWindowAt > ttlMs) {
      console.warn(`${logTag} credstore lookup failed for ${alias} (falling back to env): ${err.message ?? err}`);
      entry.warnedWindowAt = now;
    }
  }
  if (!value) {
    value = process.env[alias] ?? null;
  }
  if (value) {
    entry.value = value;
    entry.expiresAt = Date.now() + ttlMs;
  }
  return value;
}

/**
 * Force-flush a cached secret. Called from AdminService's setSecretValue /
 * rotateSecretValue / clearSecretValue handlers so a rotation via the admin
 * UI takes effect on the next call instead of waiting up to TTL for the
 * cache to expire.
 *
 * Idempotent — calling for an uncached alias is a no-op.
 */
export function invalidateSecret(alias) {
  _state.cache.delete(alias);
}

/** Test-only: clear all cached values + warn-windows. */
export function _resetForTests() {
  _state.cache.clear();
}
