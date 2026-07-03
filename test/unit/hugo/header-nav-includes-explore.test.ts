// test/unit/hugo/header-nav-includes-explore.test.ts
//
// The Hugo header partial owns the Navigate popover. Add a /explore entry
// next to "Tutorial navigator". Cheap regex pin so a future edit can't
// silently drop the link.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const header = readFileSync(
  path.resolve(import.meta.dirname, '../../../hugo/layouts/partials/header.html'),
  'utf8',
)

describe('header.html — Knowledge Graph nav entry', () => {
  it('has a /explore <ui5-li>', () => {
    // Match the line shape — icon + data-href + text — without overspecifying
    // the icon (so we can iterate on visuals without breaking the test).
    // The href points at /explore/about/ (landing sub-page); anything under
    // /explore/... is accepted so future re-routing doesn't break the test.
    const re = /<ui5-li[^>]*data-href="\/explore(?:\/[^"]*)?"[^>]*>([^<]+)<\/ui5-li>/
    const m = header.match(re)
    expect(m, '/explore <ui5-li> in nav popover').toBeTruthy()
    expect(m![1].trim().toLowerCase()).toMatch(/knowledge graph/)
  })
})
