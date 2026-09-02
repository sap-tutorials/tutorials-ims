import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

// Approuter-native CJS module (like sitemap-index-redirect / security-txt).
const require = createRequire(import.meta.url)
const {
  searchRedirectHandler,
  matchSearchUrl,
  NAVIGATOR_PATH,
} = require('../../approuter/lib/search-redirect.js')

// Minimal (req, res, next) mock, same shape as sitemap-index-redirect.test.js.
function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this },
    end(payload) { this.body = payload; return this },
  }
}

describe('matchSearchUrl', () => {
  it('maps the bare /search entry point to the navigator', () => {
    expect(matchSearchUrl('/search')).toBe('/tutorial-navigator/')
    expect(matchSearchUrl('/search/')).toBe('/tutorial-navigator/')
  })

  it('preserves the query string', () => {
    expect(matchSearchUrl('/search?q=cap')).toBe('/tutorial-navigator/?q=cap')
    expect(matchSearchUrl('/search/?q=cap')).toBe('/tutorial-navigator/?q=cap')
    expect(matchSearchUrl('/search?q=a&tag=b')).toBe('/tutorial-navigator/?q=a&tag=b')
  })

  it('does NOT match deeper /search/<path> URLs (those proxy to srv-api)', () => {
    expect(matchSearchUrl('/search/foo')).toBeNull()
    expect(matchSearchUrl('/search/tutorials.json')).toBeNull()
    expect(matchSearchUrl('/search/?q=cap'.replace('/?', '/x?'))).toBeNull() // '/searchx?...'
  })

  it('ignores unrelated / lookalike paths', () => {
    expect(matchSearchUrl('/searching')).toBeNull()
    expect(matchSearchUrl('/foo/search')).toBeNull()
    expect(matchSearchUrl('/tutorials-qa/search')).toBeNull()
  })

  it('handles non-string / empty input defensively', () => {
    expect(matchSearchUrl('')).toBeNull()
    expect(matchSearchUrl(undefined)).toBeNull()
    expect(matchSearchUrl(null)).toBeNull()
  })
})

describe('searchRedirectHandler — approuter middleware', () => {
  it('301s /search to the navigator with a 1-day cache', () => {
    const res = mockRes()
    let nexted = false
    searchRedirectHandler({ method: 'GET', url: '/search', headers: {} }, res, () => { nexted = true })
    expect(nexted).toBe(false)
    expect(res.statusCode).toBe(301)
    expect(res.headers.Location).toBe(NAVIGATOR_PATH)
    expect(res.headers['Cache-Control']).toMatch(/max-age=86400/)
    expect(res.body).toBeUndefined()
  })

  it('301s /search?q=cap preserving the query', () => {
    const res = mockRes()
    searchRedirectHandler({ method: 'GET', url: '/search?q=cap', headers: {} }, res, () => {})
    expect(res.statusCode).toBe(301)
    expect(res.headers.Location).toBe('/tutorial-navigator/?q=cap')
  })

  it('answers HEAD with the same 301', () => {
    const res = mockRes()
    searchRedirectHandler({ method: 'HEAD', url: '/search', headers: {} }, res, () => {})
    expect(res.statusCode).toBe(301)
    expect(res.headers.Location).toBe(NAVIGATOR_PATH)
  })

  it('passes /search/<path> through untouched (proxied to srv-api downstream)', () => {
    const res = mockRes()
    let nexted = false
    searchRedirectHandler({ method: 'GET', url: '/search/tutorials.json', headers: {} }, res, () => { nexted = true })
    expect(nexted).toBe(true)
    expect(res.statusCode).toBeNull()
  })

  it('passes through non-GET/HEAD methods', () => {
    const res = mockRes()
    let nexted = false
    searchRedirectHandler({ method: 'POST', url: '/search', headers: {} }, res, () => { nexted = true })
    expect(nexted).toBe(true)
    expect(res.statusCode).toBeNull()
  })
})
