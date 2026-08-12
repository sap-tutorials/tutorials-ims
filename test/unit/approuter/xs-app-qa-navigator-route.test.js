// test/unit/approuter/xs-app-qa-navigator-route.test.js
//
// #1675 — the QA channel's tutorial navigator is served at
// `/tutorial-navigator-qa/` from srv-qa's CAP content-pages endpoint
// (`/content/pages/tutorial-navigator/`, the `page-tutorial-navigator` BLOB in
// tutorials-hana-qa), mirroring prod's Phase-2 flip. This pins the route so a
// future edit can't drop it, mis-scope it, or accidentally let the QA regex
// clobber the public prod `/tutorial-navigator/` route.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const xsApp = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../../approuter/xs-app.json'), 'utf8'),
)

const qaNav = xsApp.routes.find(
  (r) => typeof r.source === 'string' && r.source.includes('tutorial-navigator-qa'),
)

const prodNav = xsApp.routes.find(
  (r) =>
    typeof r.source === 'string' &&
    r.source.startsWith('^/tutorial-navigator/') &&
    r.destination === 'srv-api',
)

describe('approuter /tutorial-navigator-qa/ route (#1675)', () => {
  it('exists and targets srv-qa content-pages', () => {
    expect(qaNav, '/tutorial-navigator-qa route').toBeTruthy()
    expect(qaNav.destination).toBe('srv-qa-api')
    expect(qaNav.target).toBe('/content/pages/tutorial-navigator/$1')
  })

  it('is Author-scoped (author-preview gate, like every /tutorials-qa/* route)', () => {
    expect(qaNav.authenticationType).toBe('xsuaa')
    expect(qaNav.scope).toBe('$XSAPPNAME.Tutorial.Author')
  })

  it('regex matches the bare path, the query variant, and no-trailing-slash', () => {
    const re = new RegExp(qaNav.source)
    expect(re.test('/tutorial-navigator-qa/')).toBe(true)
    expect(re.test('/tutorial-navigator-qa')).toBe(true)
    expect(re.test('/tutorial-navigator-qa/?foo=bar')).toBe(true)
  })

  it('does NOT match the public prod /tutorial-navigator/ route (no clobber)', () => {
    const re = new RegExp(qaNav.source)
    expect(re.test('/tutorial-navigator/')).toBe(false)
    expect(re.test('/tutorial-navigator')).toBe(false)
  })

  it('the prod /tutorial-navigator/ route stays public and does not match the QA path', () => {
    expect(prodNav, 'prod /tutorial-navigator route').toBeTruthy()
    expect(prodNav.authenticationType).toBe('none')
    const re = new RegExp(prodNav.source)
    expect(re.test('/tutorial-navigator-qa/')).toBe(false)
  })
})
