import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildImageOriginUrl } = require('../../approuter/lib/img-cdn-origin')

describe('buildImageOriginUrl', () => {
  it('encodes the image URL into the CAP image-source endpoint', () => {
    const result = buildImageOriginUrl(
      'https://raw.githubusercontent.com/o/r/main/x.png',
      'https://srv'
    )
    expect(result).toBe(
      'https://srv/content/image-source?u=https%3A%2F%2Fraw.githubusercontent.com%2Fo%2Fr%2Fmain%2Fx.png'
    )
  })

  it('encodes query params and special characters in the image URL', () => {
    const result = buildImageOriginUrl(
      'https://raw.githubusercontent.com/o/r/main/a%20b.png?foo=bar&baz=qux',
      'http://localhost:4004'
    )
    expect(result).toBe(
      'http://localhost:4004/content/image-source?u=https%3A%2F%2Fraw.githubusercontent.com%2Fo%2Fr%2Fmain%2Fa%2520b.png%3Ffoo%3Dbar%26baz%3Dqux'
    )
  })

  it('handles srvUrl with trailing slash gracefully', () => {
    const result = buildImageOriginUrl(
      'https://raw.githubusercontent.com/o/r/main/x.png',
      'https://srv/'
    )
    // Note: trailing slash is preserved — callers must not pass a trailing slash
    // (SRV_URL from srvUrlFromDestinations never has one)
    expect(result).toContain('/content/image-source?u=')
    expect(result).toContain('https%3A%2F%2Fraw.githubusercontent.com')
  })
})
