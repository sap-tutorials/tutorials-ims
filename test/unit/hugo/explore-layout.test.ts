// Text-grep test on hugo/layouts/explore/single.html. No Hugo runtime
// needed — we just assert the layout has the right structural pieces.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const LAYOUT = path.resolve(
  import.meta.dirname,
  '../../../hugo/layouts/explore/single.html',
)

describe('hugo/layouts/explore/single.html', () => {
  const html = readFileSync(LAYOUT, 'utf8')

  it('references the explore_bundle data file', () => {
    expect(html).toMatch(/site\.Data\.explore_bundle/)
  })

  it('mounts the Vue island into #explore-app (not #app)', () => {
    expect(html).toMatch(/id="explore-app"/)
    // Defensive: catch a future regression that mounts into Hugo's chrome.
    expect(html).not.toMatch(/<div id="app">/)
  })

  it('has a {{ else }} branch for the missing-manifest case', () => {
    // The {{ with site.Data.explore_bundle }}...{{ else }} block renders
    // a visible build-error message when the manifest is absent (e.g.
    // forgot to run `npm run build:explore` before Hugo).
    expect(html).toMatch(/\{\{\s*else\s*\}\}/)
    expect(html).toMatch(/explore-build-error/)
  })

  it('uses the hashed JS bundle path', () => {
    // Hashed name keeps cache-busting; matches the Vite output convention.
    expect(html).toMatch(/\/explore-ui\/main-/)
  })

  it('defines a "main" Hugo block (inherits from baseof.html)', () => {
    expect(html).toMatch(/\{\{\s*define\s+"main"\s*\}\}/)
  })
})
