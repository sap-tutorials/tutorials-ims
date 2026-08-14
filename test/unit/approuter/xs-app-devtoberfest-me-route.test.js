// test/unit/approuter/xs-app-devtoberfest-me-route.test.js
//
// #1788 — "Join Devtoberfest without logged in → CsrfFetchError".
// Root cause: `/api/devtoberfest/me` was `authenticationType: "xsuaa"`, so an
// anonymous AJAX probe got a 200 login-redirect HTML page instead of the
// handler's clean 401. The homepage island then mis-classified the visitor as
// `unregistered`, opened the Terms dialog, and csrfFetch threw during the
// `/auth/user` token handshake (200, empty x-csrf-token header).
//
// The `me` probe MUST resolve to a `none` route so the handler's real 401
// reaches the browser (the JWT is still forwarded on `none` routes when a
// session exists — same pattern as `my-completions`, #1577). This pins that so
// a future edit can't silently push `me` back behind xsuaa. The `join` write
// endpoint stays xsuaa (edge-protected; only ever reached by logged-in users).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const xsApp = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../../approuter/xs-app.json'), 'utf8'),
)

// Approuter resolves routes top-to-bottom, first regex match wins.
function resolveRoute(reqPath) {
  return xsApp.routes.find(
    (r) => typeof r.source === 'string' && new RegExp(r.source).test(reqPath),
  )
}

describe('approuter /api/devtoberfest/me route (#1788)', () => {
  it('the /me probe resolves to a `none` auth route (handler 401 reaches the browser)', () => {
    const route = resolveRoute('/api/devtoberfest/me')
    expect(route, 'a route must match /api/devtoberfest/me').toBeTruthy()
    expect(route.authenticationType).toBe('none')
    expect(route.destination).toBe('srv-api')
  })

  it('the /me route also matches the query-string variant', () => {
    const route = resolveRoute('/api/devtoberfest/me?x=1')
    expect(route).toBeTruthy()
    expect(route.authenticationType).toBe('none')
  })

  it('the /join write endpoint stays xsuaa (edge-protected)', () => {
    const route = resolveRoute('/api/devtoberfest/join')
    expect(route, 'a route must match /api/devtoberfest/join').toBeTruthy()
    expect(route.authenticationType).toBe('xsuaa')
    expect(route.destination).toBe('srv-api')
  })
})
