// test/parsers/render-link-hook.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

const p = 'hugo/layouts/_default/_markup/render-link.html'

describe('render-link hook', () => {
  it('exists', () => { expect(existsSync(p)).toBe(true) })
  it('wraps raw.githubusercontent destinations to the attachment endpoint', () => {
    const t = readFileSync(p, 'utf8')
    expect(t).toContain('raw.githubusercontent.com')
    expect(t).toContain('/content/attachment-source?u=')
    expect(t).toContain('dl=1')                 // download sibling
    expect(t).toContain('base64Encode')         // base64url-encodes the source URL (WAF-safe, #1931)
  })
  it('has a passthrough branch for non-attachment links', () => {
    const t = readFileSync(p, 'utf8')
    expect(t).toContain('.Destination | safeURL') // default anchor emission
  })
  it('guards the default branch with a safe-scheme allowlist (#2680 XSS)', () => {
    const t = readFileSync(p, 'utf8')
    // The default (non-attachment) anchor must only emit .Destination through
    // safeURL when the scheme is allowlisted; otherwise it collapses to "#".
    // This blocks javascript:/data:/vbscript: markdown-link XSS that the
    // build-time HTML sanitizer does not cover (it only runs on raw-HTML <a>).
    expect(t).toContain('$safe')
    expect(t).toMatch(/if\s+\$safe/)                       // conditional emission
    expect(t).toContain('{{ if $safe }}{{ .Destination | safeURL }}{{ else }}#{{ end }}')
    // Allowlist covers the four safe scheme classes.
    expect(t).toContain('"http://"')
    expect(t).toContain('"https://"')
    expect(t).toContain('"mailto:"')
    expect(t).toMatch(/hasPrefix \$dest "\/"/)             // site-relative
    expect(t).toMatch(/hasPrefix \$dest "#"/)              // fragment
    // The unguarded sink the vuln relied on must be gone: no bare
    // `href="{{ .Destination | safeURL }}"` outside the $safe conditional.
    expect(t).not.toMatch(/href="\{\{ \.Destination \| safeURL \}\}"/)
  })
})
