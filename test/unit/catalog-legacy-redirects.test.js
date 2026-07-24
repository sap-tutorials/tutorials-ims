import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

// Approuter-native CJS module (like bearer-auth / safe-fetch).
const require = createRequire(import.meta.url)
const { normalizeLegacyCatalogUrl } = require('../../approuter/lib/catalog-legacy-redirects.js')

describe('normalizeLegacyCatalogUrl', () => {
  it('normalizes a legacy group URL to the canonical prefixed path', () => {
    expect(normalizeLegacyCatalogUrl('/group.deploy-full-stack-cap-kyma-runtime.html'))
      .toBe('/tutorials/group-deploy-full-stack-cap-kyma-runtime')
  })

  it('normalizes a legacy mission URL to the canonical prefixed path', () => {
    expect(normalizeLegacyCatalogUrl('/mission.get-started-with-abap.html'))
      .toBe('/tutorials/mission-get-started-with-abap')
  })

  it('is case-insensitive on the group./mission. prefix and .html suffix', () => {
    expect(normalizeLegacyCatalogUrl('/GROUP.some-slug.HTML'))
      .toBe('/tutorials/group-some-slug')
    expect(normalizeLegacyCatalogUrl('/Mission.some-slug.Html'))
      .toBe('/tutorials/mission-some-slug')
  })

  it('lowercases a mixed-case slug (collapses serveHandler lowercase hop)', () => {
    expect(normalizeLegacyCatalogUrl('/group.Deploy-Full-Stack.html'))
      .toBe('/tutorials/group-deploy-full-stack')
  })

  it('preserves the query string', () => {
    expect(normalizeLegacyCatalogUrl('/group.foo.html?utm_source=news&x=1'))
      .toBe('/tutorials/group-foo?utm_source=news&x=1')
  })

  it('returns null for non-catalog .html URLs (left to the Hugo catch-all)', () => {
    expect(normalizeLegacyCatalogUrl('/tutorial-navigator.html')).toBeNull()
    expect(normalizeLegacyCatalogUrl('/some-tutorial.html')).toBeNull()
    expect(normalizeLegacyCatalogUrl('/topics/cap.html')).toBeNull()
  })

  it('returns null for already-canonical paths', () => {
    expect(normalizeLegacyCatalogUrl('/tutorials/group-foo')).toBeNull()
    expect(normalizeLegacyCatalogUrl('/tutorials/mission-foo')).toBeNull()
  })

  it('returns null when the legacy slug cannot be a canonical slug', () => {
    // Embedded dot in slug → not VALID_SLUG; leave for the normal 404 path
    // rather than 301-ing into a guaranteed miss.
    expect(normalizeLegacyCatalogUrl('/group.foo.bar.html')).toBeNull()
    // Leading hyphen is not a valid canonical slug start.
    expect(normalizeLegacyCatalogUrl('/group.-foo.html')).toBeNull()
  })

  it('does not match a deeper path or slashed slug', () => {
    expect(normalizeLegacyCatalogUrl('/x/group.foo.html')).toBeNull()
    expect(normalizeLegacyCatalogUrl('/group.foo/bar.html')).toBeNull()
  })

  it('ignores unrelated prefixes', () => {
    expect(normalizeLegacyCatalogUrl('/grouped.foo.html')).toBeNull()
    expect(normalizeLegacyCatalogUrl('/missions.html')).toBeNull()
  })

  it('handles non-string / empty input defensively', () => {
    expect(normalizeLegacyCatalogUrl('')).toBeNull()
    expect(normalizeLegacyCatalogUrl(undefined)).toBeNull()
    expect(normalizeLegacyCatalogUrl(null)).toBeNull()
  })
})
