// srv/lib/secret-presence.js
//
// #1018 — silent-credstore-write-failure guards. Shared "is this alias
// resolvable in credstore?" probe used by three surfaces that want to
// distinguish "row exists in HANA metadata" from "value actually retrievable":
//
//   1. srv/jobs/secret-expiry-check.js — daily cron classifies CRITICAL for
//      any missing key so the notifications popover shows it.
//   2. srv/admin-service.js secretWarnings() — same popover, live view.
//   3. srv/admin-service.js Secrets after('READ') hook — virtual `hasValue`
//      column on the /admin-ui/#secrets LR so admins see missing rows at
//      a glance.
//
// Why a shared module (not just readSecret() inline everywhere):
//   • Consistency — every surface classifies transport errors the same
//     way ('null' means missing OR unreachable; the popover reason string
//     encodes both cases the same because they're indistinguishable to
//     the admin — the row is dark either way).
//   • Cache — a 5-min TTL cache keeps FE List Report refreshes from
//     hammering credstore on every $refresh() (11 tracked secrets × 5s
//     refresh = 2.2 req/s baseline; the LR polls when the tab is active).
//     The cron uses `force: true` on its daily run to bypass staleness.
//   • Test ergonomics — one _resetForTests() call in test setup instead
//     of remembering to reset each surface's implicit cache.
//
// Module-singleton multiplicity defense via globalThis Symbol — same
// pattern as srv/lib/credstore.js + srv/lib/secret-resolver.js. See the
// [feedback_module_singletons_in_vitest_cds] memory.

const DEFAULT_TTL_MS = 5 * 60 * 1000;

const STATE_KEY = Symbol.for('com.sap.developers.ims:secret-presence');
const _state = (globalThis[STATE_KEY] ??= {
  // Map<alias, { present: boolean, expiresAt: number }>
  //   present === true  → readSecret returned a non-null string
  //   present === false → readSecret returned null (404) OR threw a
  //                       transport error. Both look identical to the
  //                       admin — the row is unusable.
  cache: new Map(),
});

/**
 * Check whether an alias resolves to a non-null value in the BTP
 * Credential Store. Cached for 5 minutes per alias.
 *
 * Returns:
 *   - true  → alias has a value in credstore right now (or within TTL).
 *   - false → alias is missing from credstore (404) OR credstore is
 *             unreachable. Both cases surface as "missing" to the admin
 *             because they're indistinguishable operationally — the
 *             admin needs to save a value either way.
 *
 * NEVER throws. Callers can safely use the return value directly.
 *
 * @param {string} alias
 * @param {object} [opts]
 * @param {boolean} [opts.force] — bypass cache; useful for the daily cron
 * @param {number} [opts.ttlMs] — cache TTL, default 5 min
 * @returns {Promise<boolean>}
 */
export async function checkSecretPresence(alias, opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (!opts.force) {
    const cached = _state.cache.get(alias);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.present;
    }
  }
  let present = false;
  try {
    // Dynamic import: matches secret-resolver.js — avoids paying boot
    // latency for readSecret's binding lookup when the surface isn't
    // exercised. Same reason readSecret is dynamic-imported there.
    const { readSecret } = await import('./credstore.js');
    const value = await readSecret(alias);
    present = value != null && value.length > 0;
  } catch {
    // Transport error, JWE decrypt failure, binding missing → present=false.
    // Loud logging happens in the caller if the caller cares (the daily
    // cron warns per alias; the FE List Report just badges it red).
    present = false;
  }
  _state.cache.set(alias, {
    present,
    expiresAt: Date.now() + ttlMs,
  });
  return present;
}

/**
 * Batch variant — runs checkSecretPresence for a list of aliases in
 * parallel. Used by the daily cron (Guard 2) and the Secrets after('READ')
 * hook (Guard 3). Returns a Map<alias, boolean>.
 *
 * @param {string[]} aliases
 * @param {object} [opts] — forwarded to checkSecretPresence
 * @returns {Promise<Map<string, boolean>>}
 */
export async function checkAllPresence(aliases, opts = {}) {
  const entries = await Promise.all(
    aliases.map(async (alias) => [alias, await checkSecretPresence(alias, opts)]),
  );
  return new Map(entries);
}

/**
 * Hot-flush the presence cache for one alias. Called by AdminService's
 * setSecretValue / rotateSecretValue / clearSecretValue handlers so a
 * write shows up in the LR badge / popover on the next refresh instead
 * of waiting up to TTL.
 *
 * Idempotent — no-op for uncached aliases.
 */
export function invalidatePresence(alias) {
  _state.cache.delete(alias);
}

/** Test-only: clear the entire cache. */
export function _resetForTests() {
  _state.cache.clear();
}

/**
 * Test-only: prime the cache without going through credstore. Symmetric
 * to secret-resolver.js#_primeForTests. Use from beforeEach blocks to
 * assert downstream code without stubbing credstore.js.
 */
export function _primeForTests(alias, present, { ttlMs = DEFAULT_TTL_MS } = {}) {
  _state.cache.set(alias, {
    present,
    expiresAt: Date.now() + ttlMs,
  });
}
