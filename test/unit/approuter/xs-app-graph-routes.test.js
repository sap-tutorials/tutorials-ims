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
})
