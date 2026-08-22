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
    expect(t).toContain('urlquery')             // encodes the source URL
  })
  it('has a passthrough branch for non-attachment links', () => {
    const t = readFileSync(p, 'utf8')
    expect(t).toContain('.Destination | safeURL') // default anchor emission
  })
})
