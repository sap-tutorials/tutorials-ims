// test/unit/approuter/xs-app-graph-routes.test.js
//
// The /graph/* approuter route table has two branches:
//   1. read-allowlist  (neighborhood, Concepts, ConceptEdges, ...)
//   2. catch-all       (every other /graph/* — admin scope)
//
// After 2026-06-28 the read-allowlist is anonymous; the catch-all stays
// admin-scoped. This test pins both halves so a future edit can't silently
// re-gate the public surface.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const xsApp = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../../approuter/xs-app.json'), 'utf8'),
)

function findRoute(predicate) {
  return xsApp.routes.find(predicate)
}

describe('approuter /graph/* routes', () => {
  it('read-allowlist branch is anonymous', () => {
    const r = findRoute((x) =>
      typeof x.source === 'string' &&
      x.source.includes('neighborhood') &&
      x.source.includes('Concepts') &&
      x.source.includes('explore-data'),
    )
    expect(r, 'read allowlist /graph route').toBeTruthy()
    expect(r.authenticationType).toBe('none')
    expect(r.destination).toBe('srv-api')
    // The allowlist must NOT carry a scope — that's what makes it public.
    expect(r.scope).toBeUndefined()
  })

  it('catch-all /graph/(.*) branch is admin-scoped', () => {
    // Last /graph route in the table — matches anything not in the allowlist.
    const all = xsApp.routes.filter((r) => typeof r.source === 'string' && r.source.startsWith('^/graph/'))
    const catchAll = all[all.length - 1]
    expect(catchAll.authenticationType).toBe('xsuaa')
    expect(catchAll.scope).toBe('$XSAPPNAME.Admin')
  })

  it('anonymous /graph/ allowlist regex matches neighborhoodFull (issue #850)', () => {
    const allowlist = xsApp.routes.find(
      (r) => typeof r.source === 'string' &&
             r.source.startsWith('^/graph/(neighborhood') &&
             r.authenticationType === 'none'
    );
    expect(allowlist, 'anon-allowlist /graph route').toBeTruthy();
    const re = new RegExp(allowlist.source);
    // Regression guard: existing sidebar case still passes.
    expect(re.test("/graph/neighborhood(slug='x')")).toBe(true);
    // The new expanded case.
    expect(re.test("/graph/neighborhoodFull(slug='x')")).toBe(true);
  });

  it('anonymous /graph/ allowlist regex matches searchKG + PublishedConcepts (#1057)', () => {
    // The ⌘K command palette fires anonymous requests against:
    //   POST /graph/searchKG              (KG group)
    //   GET  /graph/PublishedConcepts     (CONCEPTS group)
    // Both need to survive the approuter before CAP sees them. Prior to
    // #1057 they fell into the fallback `^/graph/(.*)$` route and got 401.
    const allowlist = xsApp.routes.find(
      (r) => typeof r.source === 'string' &&
             r.source.startsWith('^/graph/(neighborhood') &&
             r.authenticationType === 'none'
    );
    expect(allowlist, 'anon-allowlist /graph route').toBeTruthy();
    const re = new RegExp(allowlist.source);
    expect(re.test('/graph/searchKG')).toBe(true);
    expect(re.test('/graph/PublishedConcepts')).toBe(true);
    expect(re.test('/graph/PublishedConcepts?%24search=abap&%24top=6')).toBe(true);
  });
})

describe('approuter /tutorials-qa/* routes', () => {
  it('serves the QA index root before the QA catch-all', () => {
    const routes = xsApp.routes
    const rootIdx = routes.findIndex(r => r.source === '^/tutorials-qa/?$')
    const catchAllIdx = routes.findIndex(r => r.source === '^/tutorials-qa/(.*)$')
    expect(rootIdx).toBeGreaterThanOrEqual(0)
    expect(catchAllIdx).toBeGreaterThanOrEqual(0)
    expect(rootIdx).toBeLessThan(catchAllIdx)

    const root = routes[rootIdx]
    expect(root.localDir).toBe('static')
    expect(root.target).toBe('/qa/index.html')
    expect(root.authenticationType).toBe('xsuaa')
    expect(root.scope).toBe('$XSAPPNAME.Tutorial.Author')
  })
})

describe('approuter /build/* route', () => {
  // Regression guard: the /build/* route regex must capture an optional query
  // string, otherwise any request carrying a ?query falls through to the static
  // 404. breadcrumb-context REQUIRES ?tutorial=<slug>, so a missing query group
  // makes that endpoint 404 on every request (it silently did so on DEV+PROD
  // until this fix — the frontend degraded to stale static breadcrumb text).
  const buildRoute = xsApp.routes.find(
    (r) => typeof r.source === 'string' && r.source.startsWith('^/build/(breadcrumb-context'),
  )

  it('exists and forwards to srv-api anonymously', () => {
    expect(buildRoute, '/build/* route').toBeTruthy()
    expect(buildRoute.destination).toBe('srv-api')
    expect(buildRoute.authenticationType).toBe('none')
  })

  it('matches listed endpoints WITH a query string', () => {
    const re = new RegExp(buildRoute.source)
    // The bug: these carry a query string and used to fall through to 404.
    expect(re.test('/build/breadcrumb-context?tutorial=cap-mocking-auth')).toBe(true)
    expect(re.test('/build/catalog?foo=bar')).toBe(true)
    expect(re.test('/build/mission/cloud?x=1')).toBe(true)
    // Path-only forms still match.
    expect(re.test('/build/catalog')).toBe(true)
    expect(re.test('/build/breadcrumb-context')).toBe(true)
    // Unlisted endpoints still fall through (no accidental widening).
    expect(re.test('/build/verb-definitions')).toBe(false)
  })

  it('preserves the query string in the rewrite target', () => {
    const re = new RegExp(buildRoute.source)
    const m = re.exec('/build/breadcrumb-context?tutorial=cap-mocking-auth')
    expect(m).toBeTruthy()
    // Emulate the approuter $1$2$3 substitution.
    const target = buildRoute.target
      .replace('$1', m[1] || '')
      .replace('$2', m[2] || '')
      .replace('$3', m[3] || '')
    expect(target).toBe('/build/breadcrumb-context?tutorial=cap-mocking-auth')
  })
})
