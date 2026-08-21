import { describe, it, expect } from 'vitest'
import { resolveAttachmentLinks, isAttachmentPath } from '../../scripts/parsers/attachment-links.js'

const opts = { repo: 'abap-core-development', branch: 'main', slug: 'rap100' }
const base = 'https://raw.githubusercontent.com/sap-tutorials/abap-core-development/main/tutorials/rap100'

describe('resolveAttachmentLinks', () => {
  it('rewrites a relative allowlisted link to a raw-GitHub URL', () => {
    const out = resolveAttachmentLinks('[doc](EX2_DDLX.txt)', opts)
    expect(out).toBe(`[doc](${base}/EX2_DDLX.txt)`)
  })
  it('rewrites ./-prefixed links and strips the ./', () => {
    expect(resolveAttachmentLinks('[d](./a.csv)', opts)).toBe(`[d](${base}/a.csv)`)
  })
  it('leaves images (![]) untouched', () => {
    expect(resolveAttachmentLinks('![alt](img.png)', opts)).toBe('![alt](img.png)')
  })
  it('leaves absolute, anchor, mailto, root-relative, and ../ links untouched', () => {
    for (const s of ['[a](https://x.com/f.txt)', '[a](#sec)', '[a](mailto:x@y.z)', '[a](/other/f.txt)', '[a](../sib/f.txt)']) {
      expect(resolveAttachmentLinks(s, opts)).toBe(s)
    }
  })
  it('leaves non-allowlisted extensions untouched', () => {
    expect(resolveAttachmentLinks('[a](page.aspx)', opts)).toBe('[a](page.aspx)')
  })
  it('does not touch link-like text inside a fenced code block', () => {
    const src = '```md\n[x](y.txt)\n```'
    expect(resolveAttachmentLinks(src, opts)).toBe(src)
  })
  it('is idempotent (already-raw URLs are left as-is)', () => {
    const once = resolveAttachmentLinks('[d](EX2.txt)', opts)
    expect(resolveAttachmentLinks(once, opts)).toBe(once)
  })
  it('respects rewrite:false', () => {
    expect(resolveAttachmentLinks('[d](a.txt)', { ...opts, rewrite: false })).toBe('[d](a.txt)')
  })
  it('isAttachmentPath matches allowlist case-insensitively', () => {
    expect(isAttachmentPath('X.TXT')).toBe(true)
    expect(isAttachmentPath('x.png')).toBe(false)
  })
})
