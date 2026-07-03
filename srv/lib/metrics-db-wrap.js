// srv/lib/metrics-db-wrap.js
//
// #805 PR 2 (#909) — Passive wrapper on cds.db.run / cds.db.tx to observe HANA
// pool acquire-latency + tx wall-clock. Extracted from srv/server.js so the
// wrapping logic can be unit-tested against a mock db without booting CAP.
//
// Design references:
//   - Spec: docs/superpowers/specs/2026-07-02-805-observability-instrumentation-design.md
//     § HANA pool acquire-latency (passive wrapping)
//   - Docs: docs/developers/architecture/observability.md § Feature flags
//
// Behavior contract:
//   - installDbWrap(cds) is idempotent per-process — the second call is a
//     no-op (returns false). Guarded by globalThis.__metricsDbWrapInstalled
//     so cds.test() can re-fire cds.on('served') without double-wrap.
//   - The wrapper NEVER alters the caller's promise chain. It reads the
//     resolve/reject side-effects for timing and returns the ORIGINAL
//     promise. A throw inside the timing callback is swallowed.
//   - Metrics module calls are wrapped in try/catch — metrics is
//     silent-swallow by design (see srv/lib/metrics.js § Error handling),
//     but a defensive second layer makes the wrapper robust to future
//     regressions in metrics.js.
//
// Metrics emitted:
//   - db.acquire.ms       histogram — every cds.db.run(...) observation
//   - db.tx.ms            histogram — every db.tx(fn) end-to-end wall-clock
//   - db.tx.run.ms        histogram — every tx.run(...) inside a tx callback
//   - db.pool.timeout     counter   — error.message matches /timeout|acquire/i

import * as metrics from './metrics.js';

// Observe promise resolution/rejection without altering the caller's chain.
// Non-thenable values (unlikely for cds.db.run/tx but defensive) are recorded
// with zero-elapsed and returned as-is.
function timeAndCount(promise, metricName) {
  const started = process.hrtime.bigint();
  const finish = (isErr, err) => {
    try {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      metrics.observe(metricName, elapsedMs);
      if (isErr && err && /timeout|acquire/i.test(err.message || '')) {
        metrics.counter('db.pool.timeout');
      }
    } catch { /* metrics is silent-swallow by design; belt + braces */ }
  };
  if (!promise || typeof promise.then !== 'function') {
    finish(false);
    return promise;
  }
  promise.then(
    () => finish(false),
    (err) => finish(true, err),
  );
  return promise;
}

/**
 * Install the passive wrapper on cds.db.run and cds.db.tx.
 *
 * Idempotent per-process: subsequent calls short-circuit via the
 * globalThis.__metricsDbWrapInstalled sentinel, matching the
 * __feedbackBeforeHookRegistered / navigatorCacheInvalidatorRegistered
 * convention in srv/server.js.
 *
 * @param {object} cds - The `@sap/cds` module (or a test double).
 * @returns {boolean} true if the wrapper was installed this call,
 *   false if already installed, no db, or env-flags disabled.
 */
export function installDbWrap(cds) {
  if (process.env.METRICS_ENABLED === 'false') return false;
  if (process.env.METRICS_DB_WRAP !== 'true') return false;
  if (globalThis.__metricsDbWrapInstalled) return false;
  if (!cds?.db || typeof cds.db.run !== 'function' || typeof cds.db.tx !== 'function') {
    return false;
  }
  globalThis.__metricsDbWrapInstalled = true;

  // 1. Wrap cds.db.run — every bare query flows through here.
  const originalDbRun = cds.db.run.bind(cds.db);
  cds.db.run = function wrappedDbRun(...args) {
    return timeAndCount(originalDbRun(...args), 'db.acquire.ms');
  };

  // 2. Wrap cds.db.tx — every db.tx(fn) call flows through here.
  // Signature variants observed / potential:
  //   db.tx(fn)              — the only shape used in this codebase (7 sites)
  //   db.tx(req, fn)         — CAP tx-with-context form
  //   db.tx(opts, fn)        — options-with-callback form
  //   db.tx()                — object-form; grep confirms 0 sites in this repo
  // For each callback shape we intercept fn so the runtime-injected tx has
  // its .run patched before the user's fn runs; for object-form fall through.
  const originalDbTx = cds.db.tx.bind(cds.db);
  cds.db.tx = function wrappedDbTx(fnOrOptsOrReq, maybeFn) {
    const fnIsFirst = typeof fnOrOptsOrReq === 'function';
    const fnIsSecond = typeof maybeFn === 'function';
    if (!fnIsFirst && !fnIsSecond) {
      // Object-form — no callback to patch. Fall through un-timed rather
      // than break the caller if the runtime ever adopts this shape.
      return originalDbTx(fnOrOptsOrReq);
    }
    const userFn = fnIsFirst ? fnOrOptsOrReq : maybeFn;
    const firstArg = fnIsFirst ? undefined : fnOrOptsOrReq;
    const wrappedFn = (tx) => {
      // Patch tx.run so per-statement calls inside the callback get timed.
      // Bind against the tx instance so `this` resolves inside the runtime.
      const originalTxRun = tx.run.bind(tx);
      tx.run = (...runArgs) => timeAndCount(originalTxRun(...runArgs), 'db.tx.run.ms');
      return userFn(tx);
    };
    const invocation = firstArg === undefined
      ? originalDbTx(wrappedFn)
      : originalDbTx(firstArg, wrappedFn);
    return timeAndCount(invocation, 'db.tx.ms');
  };

  return true;
}

// Test-only helper — reset the sentinel between tests. NOT exported for
// production use; production paths should never uninstall the wrapper.
export function _resetForTest() {
  delete globalThis.__metricsDbWrapInstalled;
}
