// Structural guards for the admin-shell auth-interceptor infinite reload loop.
//
// Symptom: the Admin Console "keeps refreshing all the time" for a specific
// user. Root cause: the fetch/XHR interceptor in Component.js reloaded the
// whole page on ANY non-CSRF 403 on a backend URL — including a genuine
// AUTHORIZATION denial (an Author-only account hitting an @requires:'Admin'
// /admin/ service returns a JSON 403). Re-authenticating cannot grant the
// missing scope, and the only loop guard (`bRedirecting`) is an in-memory flag
// that resets on every reload, so the page reload-loops forever.
//
// Fix, pinned here (admin-shell has no UI runtime harness in this repo — see
// admin-shell-nav-expanded-persistence.test.ts for the same rationale):
//   1. A 403 only triggers a reload when it looks like a session artifact
//      (login HTML / redirect), NOT for a plain JSON authorization denial.
//   2. A persistent (sessionStorage) reload-loop breaker caps auto-reloads and
//      surfaces a message instead of refreshing forever.
//   3. Genuine session expiry (401, or a login-looking 200) still reloads so
//      the OAuth flow can recover the session.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const COMPONENT_JS = path.resolve(
  import.meta.dirname,
  '../../app/admin-shell/webapp/Component.js',
)

describe('admin-shell auth interceptor — no infinite reload loop', () => {
  const src = readFileSync(COMPONENT_JS, 'utf8')

  it('does NOT reload on a bare non-CSRF 403 (the old broad condition is gone)', () => {
    // The regression was `status === 401 || (status === 403 && !(bMutating &&
    // isCsrfRejection(...)))` reloading for EVERY non-CSRF 403, authz included.
    expect(
      src,
      'the combined 401/any-403 reload condition must be removed',
    ).not.toMatch(/401\s*\|\|\s*\(\s*response\.status\s*===\s*403/)
  })

  it('reloads on a 403 ONLY when it looks like a session artifact', () => {
    // A 403 that carries a login page / redirect is a session artifact and is
    // recoverable by reloading; a JSON authz 403 is not. The 403 handling must
    // gate the reload on looksLikeLoginHtml.
    expect(src).toMatch(/looksLikeLoginHtml/)
    // A comment must record the authz-403 no-reload rationale so a refactor
    // can't silently re-introduce the loop.
    expect(src.toLowerCase()).toMatch(/authoriz|authoris/)
  })

  it('has a sessionStorage-based reload-loop breaker', () => {
    // Persistent across reloads (in-memory bRedirecting resets each reload).
    expect(src).toMatch(/sessionStorage/)
    expect(src, 'must key the reload counter under a stable storage key').toMatch(
      /sap-tutorials-admin-auth-reloads/,
    )
    // A maximum-reload guard must exist (count comparison).
    expect(src).toMatch(/RELOAD_MAX|count\s*>=?\s*\d/)
  })

  it('surfaces a message instead of reloading once the loop cap is hit', () => {
    expect(src).toMatch(/MessageBox/)
  })

  it('still recovers genuine session expiry (401 and login-looking 200 reload)', () => {
    expect(src, 'a 401 on a backend URL still triggers reload').toMatch(
      /status\s*===\s*401/,
    )
    expect(src, 'the login-HTML 200 recovery path is preserved').toMatch(
      /status\s*===\s*200/,
    )
    expect(src).toMatch(/handleUnauthorized/)
  })

  it('bounds the reload counter with a time window (not a fragile clear-on-success)', () => {
    // Staleness is handled by a sliding time window so a genuine later expiry
    // still reloads. Clearing the counter on ANY backend success would let a
    // single per-load success defeat the breaker in a mixed success/failure
    // loop, so that approach is deliberately avoided.
    expect(src).toMatch(/RELOAD_WINDOW_MS/)
    // The counter is only cleared on explicit user resolution (the MessageBox),
    // never automatically on a backend 2xx.
    expect(src).toMatch(/clearReloadRec\s*\(/)
    expect(
      src,
      'must NOT auto-clear the reload counter on a generic backend 2xx',
    ).not.toMatch(/status\s*>=\s*200\s*&&[^]*clearReloadRec/)
  })
})
