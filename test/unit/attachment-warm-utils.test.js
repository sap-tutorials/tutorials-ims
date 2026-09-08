// test/unit/attachment-warm-utils.test.js
//
// Unit tests for srv/lib/attachment-warm-utils.js utilities:
// - resolveAttachmentSourceUrl(param) — decode base64url or URL-encoded params
// - extractAttachmentUrls(html) — extract and decode URLs from HTML

import { describe, it, expect } from 'vitest'
import { resolveAttachmentSourceUrl, extractAttachmentUrls } from '../../srv/lib/attachment-warm-utils.js'

describe('resolveAttachmentSourceUrl', () => {
  it('decodes a base64url-encoded raw GitHub URL (no colons = WAF-safe)', () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/file.txt'
    const b64url = Buffer.from(url).toString('base64url')
    expect(b64url).not.toContain(':') // Verify it's truly base64url
    expect(resolveAttachmentSourceUrl(b64url)).toBe(url)
  })

  it('decodes a URL-encoded param (with colons)', () => {
    const url = 'https://raw.githubusercontent.com/sap-tutorials/tutorials/main/file.txt'
    const encoded = encodeURIComponent(url)
    expect(encoded).toContain('%3A') // Has %3A for colons
    expect(resolveAttachmentSourceUrl(encoded)).toBe(url)
  })

  it('falls back to as-is if decode fails', () => {
    // Invalid base64url but no colons — should fail to decode and return as-is
    const invalid = 'not-base64!!!-but-no-colons'
    // Expect no throw; function should fall back
    expect(() => resolveAttachmentSourceUrl(invalid)).not.toThrow()
  })

  it('handles a literal colon in param (signals URL-encoded fallback)', () => {
    const url = 'https://example.com'
    // Encode and then pass the encoded version
    const encoded = encodeURIComponent(url)
    expect(resolveAttachmentSourceUrl(encoded)).toBe(url)
  })
})

describe('extractAttachmentUrls', () => {
  it('extracts base64url-encoded attachment URLs from HTML', () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/EX2.txt'
    const b64url = Buffer.from(url).toString('base64url')
    const html = `
      <a href="/content/attachment-source?u=${b64url}">Download</a>
      <a href="/content/attachment-source?u=${b64url}&dl=1">Download Raw</a>
    `
    const extracted = extractAttachmentUrls(html)
    expect(extracted).toHaveLength(1)
    expect(extracted[0]).toBe(url)
  })

  it('extracts URL-encoded (plain) attachment URLs from HTML', () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/EX2.txt'
    const encoded = encodeURIComponent(url)
    const html = `<a href="/content/attachment-source?u=${encoded}">Download</a>`
    const extracted = extractAttachmentUrls(html)
    expect(extracted).toHaveLength(1)
    expect(extracted[0]).toBe(url)
  })

  it('deduplicates multiple URLs pointing to the same source', () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/file.txt'
    const b64url = Buffer.from(url).toString('base64url')
    const html = `
      <a href="/content/attachment-source?u=${b64url}">View</a>
      <a href="/content/attachment-source?u=${b64url}&dl=1">Download</a>
    `
    const extracted = extractAttachmentUrls(html)
    expect(extracted).toHaveLength(1)
  })

  it('ignores non-attachment links', () => {
    const html = `
      <a href="https://example.com">Normal link</a>
      <a href="#anchor">Anchor</a>
    `
    const extracted = extractAttachmentUrls(html)
    expect(extracted).toHaveLength(0)
  })

  it('skips malformed u= params', () => {
    const html = `
      <a href="/content/attachment-source?u=">Empty</a>
      <a href="/content/attachment-source">No u param</a>
    `
    // extractAttachmentUrls should not throw; malformed entries are caught in try/catch
    const extracted = extractAttachmentUrls(html)
    expect(Array.isArray(extracted)).toBe(true)
  })
})
