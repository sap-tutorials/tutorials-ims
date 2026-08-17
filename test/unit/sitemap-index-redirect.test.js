import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

// Approuter-native CJS module (like security-txt / catalog-legacy-redirects).
const require = createRequire(import.meta.url)
const {
  sitemapIndexRedirectHandler,
  matchLegacySitemapUrl,
  CANONICAL_SITEMAP,
} = require('../../approuter/lib/sitemap-index-redirect.js')

// Minimal (req, res, next) mock, same shape as security-txt.test.js.
function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this },
    end(payload) { this.body = payload; return this },
  }
}

describe('matchLegacySitemapUrl', () => {
  it('maps the legacy sitemap index to the canonical sitemap', () => {
    expect(matchLegacySitemapUrl('/sitemap_index.xml')).toBe('/sitemap.xml')
  })

  it('maps every numbered legacy shard to the canonical sitemap', () => {
    expect(matchLegacySitemapUrl('/sitemap_1.xml')).toBe('/sitemap.xml')
    expect(matchLegacySitemapUrl('/sitemap_2.xml')).toBe('/sitemap.xml')
    expect(matchLegacySitemapUrl('/sitemap_42.xml')).toBe('/sitemap.xml')
  })

  it('is case-insensitive', () => {
    expect(matchLegacySitemapUrl('/SITEMAP_INDEX.XML')).toBe('/sitemap.xml')
    expect(matchLegacySitemapUrl('/Sitemap_1.Xml')).toBe('/sitemap.xml')
  })

  it('drops any query string (sitemaps take none)', () => {
    expect(matchLegacySitemapUrl('/sitemap_index.xml?utm=x')).toBe('/sitemap.xml')
  })

  it('does NOT match the live /sitemap.xml (must keep proxying to CAP)', () => {
    expect(matchLegacySitemapUrl('/sitemap.xml')).toBeNull()
    expect(matchLegacySitemapUrl('/sitemap.xml?foo=1')).toBeNull()
  })

  it('ignores unrelated / lookalike paths', () => {
    expect(matchLegacySitemapUrl('/sitemap_index.txt')).toBeNull()
    expect(matchLegacySitemapUrl('/sitemap_index.xml.bak')).toBeNull()
    expect(matchLegacySitemapUrl('/foo/sitemap_index.xml')).toBeNull()
    expect(matchLegacySitemapUrl('/sitemap_.xml')).toBeNull()
    expect(matchLegacySitemapUrl('/sitemap_index/')).toBeNull()
  })

  it('handles non-string / empty input defensively', () => {
    expect(matchLegacySitemapUrl('')).toBeNull()
    expect(matchLegacySitemapUrl(undefined)).toBeNull()
    expect(matchLegacySitemapUrl(null)).toBeNull()
  })
})

describe('sitemapIndexRedirectHandler — approuter middleware', () => {
  it('301s a legacy sitemap URL to /sitemap.xml with a 1-day cache', () => {
    const res = mockRes()
    let nexted = false
    sitemapIndexRedirectHandler(
      { method: 'GET', url: '/sitemap_index.xml', headers: {} },
      res,
      () => { nexted = true },
    )
    expect(nexted).toBe(false)
    expect(res.statusCode).toBe(301)
    expect(res.headers.Location).toBe(CANONICAL_SITEMAP)
    expect(res.headers['Cache-Control']).toMatch(/max-age=86400/)
    expect(res.body).toBeUndefined()
  })

  it('301s the numbered shards too', () => {
    const res = mockRes()
    sitemapIndexRedirectHandler({ method: 'GET', url: '/sitemap_3.xml', headers: {} }, res, () => {})
    expect(res.statusCode).toBe(301)
    expect(res.headers.Location).toBe(CANONICAL_SITEMAP)
  })

  it('answers HEAD with the same 301', () => {
    const res = mockRes()
    sitemapIndexRedirectHandler({ method: 'HEAD', url: '/sitemap_index.xml', headers: {} }, res, () => {})
    expect(res.statusCode).toBe(301)
    expect(res.headers.Location).toBe(CANONICAL_SITEMAP)
  })

  it('passes /sitemap.xml through untouched (proxied to CAP downstream)', () => {
    const res = mockRes()
    let nexted = false
    sitemapIndexRedirectHandler({ method: 'GET', url: '/sitemap.xml', headers: {} }, res, () => { nexted = true })
    expect(nexted).toBe(true)
    expect(res.statusCode).toBeNull()
  })

  it('passes through non-GET/HEAD methods', () => {
    const res = mockRes()
    let nexted = false
    sitemapIndexRedirectHandler({ method: 'POST', url: '/sitemap_index.xml', headers: {} }, res, () => { nexted = true })
    expect(nexted).toBe(true)
    expect(res.statusCode).toBeNull()
  })
})
