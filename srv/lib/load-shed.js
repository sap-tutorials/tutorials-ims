// srv/lib/load-shed.js
// Origin-side load-shedding guard (PR4, #2271) for the anonymous HANA
// content-serve path. Bounds the number of *concurrent* per-request gzip-BLOB
// reads: the serve path reads a compressed HTML BLOB from HANA and gunzips it
// per request with no static fallback, so a scraper flood that gets past the
// edge cache can saturate the DB pool and OOM the instance. Above a configured
// ceiling, excess requests are shed with 503 + Retry-After rather than piling
// up.
//
// Contract:
//   acquireServeSlot() -> Promise<{ admitted, retryAfter, release() }>
//     admitted:true  → a slot was taken; the caller MUST call release() exactly
//                      once (on success AND on every error path — use finally).
//     admitted:false → shed; retryAfter is the Retry-After hint (seconds).
//                      release() is a no-op (nothing was taken).
//
// Design notes:
//   - Flag-gated (LOADSHED_ENABLED, ImsConfig flag.loadshed). OFF → every call
//     is admitted as a no-op and NOTHING is counted, so the guard is inert and
//     a warm cache path is untouched.
//   - Fail-open: any error resolving the flag/config admits the request. The
//     guard must never block content on its own failure.
//   - The in-flight counter is pinned on globalThis so every ESM instance of
//     this module (CAP loads service modules via dynamic file:// imports whose
//     URL can differ from a static import's on Windows) shares one count —
//     same rationale as the feature-flag cache in db-flags.js.
//   - Single-process, per-instance ceiling (NOT cross-instance): the metric to
//     bound here is per-instance memory/pool pressure, so a plain in-memory
//     counter is exactly right (and needs no shared store). With N app
//     instances the effective origin ceiling is N × maxConcurrent.
//   - The check + increment run with NO await between them, so they are atomic
//     under Node's single-threaded event loop — no check-then-act race.

import cds from '@sap/cds';
import { isFlagEnabled } from './feature-flags/db-flags.js';
import { resolveLoadShedConfig } from './runtime-config/load-shed-settings.js';

const LOG = cds.log('load-shed');

const STATE_KEY = Symbol.for('com.sap.developers.ims:load-shed-inflight');
const _state = (globalThis[STATE_KEY] ??= { inFlight: 0 });

// Shared no-op admission (flag off / fail-open): admitted, no slot taken.
const ADMIT_NOOP = Object.freeze({ admitted: true, retryAfter: 0, release() {} });

/**
 * Try to take an in-flight serve slot. See the contract in the file header.
 * @returns {Promise<{admitted:boolean, retryAfter:number, release:()=>void}>}
 */
export async function acquireServeSlot() {
  try {
    // Flag off → guard inert; do not count, always admit.
    if (!isFlagEnabled('LOADSHED_ENABLED')) return ADMIT_NOOP;

    const { maxConcurrent, retryAfterSeconds } = await resolveLoadShedConfig();

    // NB: no `await` between this read of _state.inFlight and the increment
    // below — the pair is atomic on the single-threaded event loop.
    if (_state.inFlight >= maxConcurrent) {
      return { admitted: false, retryAfter: retryAfterSeconds, release() {} };
    }

    _state.inFlight += 1;
    let released = false;
    return {
      admitted: true,
      retryAfter: 0,
      release() {
        // Idempotent: a double-release must not under-count (which would let the
        // ceiling drift upward and defeat the guard).
        if (released) return;
        released = true;
        _state.inFlight -= 1;
      },
    };
  } catch (err) {
    // Fail-open: never block content on the guard's own failure.
    LOG.warn(`load-shed guard error; admitting request: ${err.message}`);
    return ADMIT_NOOP;
  }
}

/** Test-only: current in-flight count. */
export function _inFlightForTest() {
  return _state.inFlight;
}

/** Test-only: reset the in-flight counter between cases. */
export function _resetForTest() {
  _state.inFlight = 0;
}
