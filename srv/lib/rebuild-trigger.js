// srv/lib/rebuild-trigger.js
//
// Debounced GitHub workflow_dispatch trigger for admin writes.
// When admins save through AdminService, this module dispatches a rebuild
// after a 60s quiet window. The dispatch's `mode` is auto-classified by
// srv/lib/_classify-rebuild-mode.js based on what was saved.
//
// 3-mode dispatch shape (#429):
//   - 'catalog-only'   → 30-60s, skips fetch + Vue + AI quiz
//   - 'slug-targeted'  → 30-60s, re-fetches only listed slug(s)
//   - 'full'           → 10-13 min (or 3-5 min with force-cap-refetch on cache hit)
//
// Token sourcing: shared srv/lib/secret-resolver.js (credstore-first, env
// fallback, 5-min TTL cache). The Secrets row is bootstrapped manually via
// the admin Secrets UI; see
// docs/developers/operations/secrets-tracking.md#bootstrap-github_dispatch_token.
//
// Spec: docs/superpowers/specs/2026-06-22-issue-429-targeted-rebuild-design.md
// Issue: #429. Uses native fetch (Node >= 20) — no octokit dependency.

import { resolveTenantSettings } from './runtime-config/tenant-settings.js';
import {
  resolveSecret,
  invalidateSecret,
  _resetForTests as _resetResolver,
  _primeForTests as _primeResolver,
} from './secret-resolver.js';

const REPO_OWNER = 'sap-tutorials';
const REPO_NAME = 'tutorials-ims';
const WORKFLOW_FILE = 'rebuild-content.yml';
const DEFAULT_DEBOUNCE_MS = 60_000;
const GITHUB_API = 'https://api.github.com';

// Mode-merge priority — higher rank wins during the debounce window.
const RANK = { 'catalog-only': 1, 'slug-targeted': 2, 'full': 3 };

// Slug-accumulator cap. Beyond this, fall back to 'full' mode to avoid a
// massive comma-separated slugs payload to the workflow_dispatch API.
// Configurable promotion to env var is YAGNI — bulk admin operations >50
// rows in a single 60s window are rare; migration scripts skip the trigger
// entirely via x-migration-mode.
const SLUG_ACCUMULATOR_CAP = 50;

let _state = {
  // Debounce
  debounceMs: DEFAULT_DEBOUNCE_MS,
  pendingTimer: null,
  pendingReason: null,
  // Mode-merge state
  pendingMode: null,                 // null | 'catalog-only' | 'slug-targeted' | 'full'
  pendingSlugs: new Set(),
  pendingForceCapRefetch: false,
  // Injection point for tests. @type {DispatchFn}
  dispatchFn: defaultDispatch,
};

/**
 * Resolve the GITHUB_DISPATCH_TOKEN via the shared secret-resolver
 * (credstore-first, env fallback, 5-min TTL cache). Returns null if neither
 * source has a value.
 */
async function getDispatchToken() {
  return resolveSecret('GITHUB_DISPATCH_TOKEN', { logTag: '[rebuild-trigger]' });
}

/**
 * Default workflow_dispatch handler.
 *
 * @typedef {(inputs: object, token: string|null) => Promise<{status: number, skipped?: boolean}>} DispatchFn
 *
 * @param {object} inputs — workflow_dispatch inputs (trigger-source, environment, mode, slugs, force-cap-refetch).
 * @param {string|null} token — resolved GITHUB_DISPATCH_TOKEN, or null if neither credstore nor env had one.
 * @returns {Promise<{status: number, skipped?: boolean}>} — `{status: 0, skipped: true}` when no token.
 */
async function defaultDispatch(inputs, token) {
  if (!token) return { status: 0, skipped: true };
  const url = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub dispatch ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return { status: res.status };
}

/**
 * Merge a new (mode, slug, forceCapRefetch) trigger into the pending state.
 * Mode: take the higher RANK. Slug: add to Set (deduped). Cap exceeded →
 * upgrade to 'full' and clear the set. ForceCapRefetch: sticky once set.
 */
function mergePending({ mode, slug, forceCapRefetch }) {
  if (!_state.pendingMode || RANK[mode] > RANK[_state.pendingMode]) {
    _state.pendingMode = mode;
  }
  if (slug) {
    _state.pendingSlugs.add(slug);
    if (_state.pendingSlugs.size > SLUG_ACCUMULATOR_CAP) {
      console.warn(`[rebuild-trigger] slug accumulator exceeded ${SLUG_ACCUMULATOR_CAP} during 60s window — upgrading to 'full' mode and clearing slugs. Check upstream caller for bulk-write that should set x-migration-mode.`);
      _state.pendingMode = 'full';
      _state.pendingSlugs.clear();
    }
  }
  if (forceCapRefetch) {
    _state.pendingForceCapRefetch = true;
  }
}

/**
 * Schedule a rebuild dispatch after the debounce window.
 *
 * @param {string} reason — diagnostic string surfaced as 'trigger-source' input
 * @param {object} opts
 * @param {'catalog-only'|'slug-targeted'|'full'} [opts.mode='full']
 * @param {string|null} [opts.slug=null]
 * @param {boolean} [opts.forceCapRefetch=false]
 */
export async function scheduleRebuild(reason, opts = {}) {
  const mode = opts.mode ?? 'full';
  const slug = opts.slug ?? null;
  const forceCapRefetch = opts.forceCapRefetch ?? false;

  // Note: we no longer short-circuit on missing token here. getDispatchToken()
  // is async + credstore-backed; deferring the check to dispatch time lets us
  // pick up a freshly-set token without restarting srv. The default dispatchFn
  // returns { skipped: true } when token is unset.

  if (_state.pendingTimer) {
    clearTimeout(_state.pendingTimer);
  }
  _state.pendingReason = reason;
  mergePending({ mode, slug, forceCapRefetch });

  _state.pendingTimer = setTimeout(async () => {
    const reasonAtFire = _state.pendingReason;
    const modeAtFire = _state.pendingMode ?? 'full';
    const slugsAtFire = [..._state.pendingSlugs];
    const forceCapRefetchAtFire = _state.pendingForceCapRefetch;
    // Reset state immediately so a new trigger during the dispatch starts
    // a fresh window.
    _state.pendingTimer = null;
    _state.pendingReason = null;
    _state.pendingMode = null;
    _state.pendingSlugs = new Set();
    _state.pendingForceCapRefetch = false;

    try {
      const token = await getDispatchToken();
      if (!token) {
        // No token reachable from credstore or env. Skip dispatch entirely;
        // checkFeatureFlag() has already logged the gap at boot.
        return;
      }
      const { rebuildTargetEnv } = await resolveTenantSettings();
      const inputs = {
        'trigger-source': reasonAtFire,
        environment: rebuildTargetEnv,
        mode: modeAtFire,
      };
      if (modeAtFire === 'slug-targeted' && slugsAtFire.length > 0) {
        inputs.slugs = slugsAtFire.join(',');
      }
      if (forceCapRefetchAtFire) {
        inputs['force-cap-refetch'] = true;
      }
      await _state.dispatchFn(inputs, token);
    } catch (err) {
      console.error('[rebuild-trigger] dispatch failed:', err.message ?? err);
      // Do NOT rethrow. Admin save already succeeded; the next trigger
      // picks up the missed change.
    }
  }, _state.debounceMs);
}

// One-time boot warning if no token is reachable.
let _bootWarned = false;
export async function checkFeatureFlag() {
  if (_bootWarned) return;
  _bootWarned = true;
  const token = await getDispatchToken();
  if (!token) {
    console.warn('[rebuild-trigger] GITHUB_DISPATCH_TOKEN unreachable from credstore or env — admin writes will not trigger rebuilds. Set via /admin-ui/#secrets-display.');
  } else {
    console.log('[rebuild-trigger] active — admin writes will dispatch (target env resolved per-call from TenantSettings).');
  }
}

// Test-only escape hatch.
export function _resetForTests({ dispatchFn, debounceMs, token } = {}) {
  if (_state.pendingTimer) clearTimeout(_state.pendingTimer);
  _state = {
    debounceMs: debounceMs ?? DEFAULT_DEBOUNCE_MS,
    pendingTimer: null,
    pendingReason: null,
    pendingMode: null,
    pendingSlugs: new Set(),
    pendingForceCapRefetch: false,
    dispatchFn: dispatchFn ?? defaultDispatch,
  };
  // Seed (or clear) the shared resolver cache so existing tests that pass
  // `token: 'fake-token'` keep working without reaching into credstore/env.
  // Synchronous so it composes with vi.useFakeTimers() in the test suite.
  if (token !== undefined) {
    _resetResolver();
    if (token) _primeResolver('GITHUB_DISPATCH_TOKEN', token);
  }
  _bootWarned = false;
}

/**
 * Force-flush the cached GITHUB_DISPATCH_TOKEN. Called by the Secrets admin
 * write handlers (setSecretValue / rotateSecretValue / clearSecretValue) so
 * a rotation via the UI takes effect on the next dispatch instead of waiting
 * up to 5 minutes for the TTL to expire.
 *
 * Thin shim over secret-resolver.invalidateSecret — kept as a separate
 * export so admin-service.js callers stay stable.
 */
export function invalidateDispatchTokenCache() {
  invalidateSecret('GITHUB_DISPATCH_TOKEN');
}
