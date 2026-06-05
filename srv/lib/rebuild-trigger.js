// srv/lib/rebuild-trigger.js
//
// Debounced GitHub workflow_dispatch trigger for admin writes.
// When admins save a Mission/Group/FeaturedTasks entity, /browse/ SSR's
// catalog goes stale until the next Hugo rebuild. This module collapses
// bulk edits into one rebuild dispatch within a 60s window.
//
// Behind a feature flag: if GITHUB_DISPATCH_TOKEN is unset, this is a
// no-op. Local dev never tries to dispatch.
//
// Spec: docs/superpowers/specs/2026-06-02-browse-layout-design.md (Q11)
// Uses native fetch (Node >= 20) — no octokit dependency.

const REPO_OWNER = 'sap-tutorials'
const REPO_NAME = 'tutorials-ims'
const WORKFLOW_FILE = 'rebuild-content.yml'
const DEFAULT_DEBOUNCE_MS = 60_000
const GITHUB_API = 'https://api.github.com'

let _state = {
  token: process.env.GITHUB_DISPATCH_TOKEN ?? null,
  // REBUILD_TARGET_ENV controls which Cloud Foundry approuter the rebuild
  // workflow_dispatch targets. Default 'dev' matches the original DEV-only
  // rollout; set per CF env (qa/prod) when GITHUB_DISPATCH_TOKEN rolls
  // forward to those environments. See docs/developers/operations/github-dispatch-pat-rotation.md.
  environment: process.env.REBUILD_TARGET_ENV ?? 'dev',
  debounceMs: DEFAULT_DEBOUNCE_MS,
  pendingTimer: null,
  pendingReason: null,
  dispatchFn: defaultDispatch,
}

async function defaultDispatch(inputs) {
  if (!_state.token) return { status: 0, skipped: true }
  const url = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_FILE}/dispatches`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${_state.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub dispatch ${res.status} ${res.statusText}: ${body.slice(0, 200)}`)
  }
  return { status: res.status }
}

export function scheduleRebuild(reason) {
  if (!_state.token) {
    return  // Feature flag off — no-op silently. Token-missing is logged once at boot.
  }
  if (_state.pendingTimer) {
    // A dispatch is already pending — reset the timer to extend the window.
    // Multiple admin saves in rapid succession all collapse into one dispatch
    // after 60s of quiet.
    clearTimeout(_state.pendingTimer)
  }
  _state.pendingReason = reason
  _state.pendingTimer = setTimeout(() => {
    const reasonAtFire = _state.pendingReason
    _state.pendingTimer = null
    _state.pendingReason = null
    _state.dispatchFn({ 'trigger-source': reasonAtFire, environment: _state.environment }).catch((err) => {
      console.error('[rebuild-trigger] dispatch failed:', err.message ?? err)
      // Do NOT rethrow. Admin save already succeeded; the next trigger
      // picks up the missed change.
    })
  }, _state.debounceMs)
}

// One-time boot warning if token is unset, so ops sees the feature flag is off.
let _bootWarned = false
export function checkFeatureFlag() {
  if (!_state.token && !_bootWarned) {
    _bootWarned = true
    console.warn('[rebuild-trigger] GITHUB_DISPATCH_TOKEN unset — admin writes will not trigger /browse/ rebuilds. Falls back to next-push cadence.')
  } else if (_state.token && !_bootWarned) {
    _bootWarned = true
    console.log(`[rebuild-trigger] active — admin writes will dispatch with environment='${_state.environment}'.`)
  }
}

// Test-only escape hatch.
export function _resetForTests({ dispatchFn, debounceMs, token, environment }) {
  if (_state.pendingTimer) clearTimeout(_state.pendingTimer)
  _state = {
    token: token ?? null,
    environment: environment ?? 'dev',
    debounceMs: debounceMs ?? DEFAULT_DEBOUNCE_MS,
    pendingTimer: null,
    pendingReason: null,
    dispatchFn: dispatchFn ?? defaultDispatch,
  }
  _bootWarned = false
}
