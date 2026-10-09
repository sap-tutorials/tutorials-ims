import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { convertBody, precheck } from '../convert-body.mjs'

const fx = (n: string) => readFileSync(join(__dirname, 'fixtures', n), 'utf-8')

describe('convertBody — title & description', () => {
  it('promotes the first H2 to H1 and inserts a description marker placeholder', () => {
    const { body } = convertBody(fx('01-title-source.md'), 'build-cap-app')
    expect(body).toBe(fx('01-title-expected.md'))
  })

  it('flags when no H2 title is found', () => {
    const { flags } = convertBody('Just a paragraph, no heading.', 'x')
    expect(flags).toContain('NO_TITLE: no leading "## " heading found; set the H1 title manually')
  })
})

describe('convertBody — details to OPTION', () => {
  it('converts open and closed <details> into OPTION blocks, dropping the open attr', () => {
    const { body } = convertBody(fx('02-details-source.md'), 'x')
    expect(body).toBe(fx('02-details-expected.md'))
  })

  it('flags nested <details> instead of converting them', () => {
    const { flags } = convertBody(fx('02-nested-source.md'), 'x')
    expect(flags).toContain('NESTED_DETAILS: nested <details> cannot map to OPTION blocks; convert this section manually')
  })
})

describe('convertBody — images & fences', () => {
  it('strips ./ from image paths, drops layout comments, collects image list', () => {
    const { body, images } = convertBody(fx('03-images-source.md'), 'x')
    expect(body).toBe(fx('03-images-expected.md'))
    expect(images).toEqual(['bas-terminal.png', 'domain.png'])
  })

  it('flags a code fence missing a language tag', () => {
    const { flags } = convertBody('```\nplain\n```\n', 'x')
    expect(flags).toContain('FENCE_NO_LANG: a code fence has no language tag; add one (e.g. ```bash)')
  })
})

describe('precheck', () => {
  it('passes a well-formed tutorial', () => {
    const md = `---\nparser: v2\n---\n# T\n<!-- description -->d\n\n### S\n![x](a.png)\n`
    expect(precheck(md, 'build-cap-app', ['a.png'])).toEqual([])
  })
  it('reports unbalanced OPTION blocks', () => {
    const md = `---\nparser: v2\n---\n# T\n[OPTION BEGIN [Node.js]]\nx\n`
    expect(precheck(md, 'x', [])).toContain('UNBALANCED_OPTIONS: 1 [OPTION BEGIN] vs 0 [OPTION END]')
  })
  it('reports a missing image', () => {
    const md = `---\nparser: v2\n---\n# T\n![x](missing.png)\n`
    expect(precheck(md, 'x', [])).toContain('MISSING_IMAGE: missing.png is referenced but not on disk')
  })
  it('reports an uppercase slug', () => {
    const md = `---\nparser: v2\n---\n# T\n`
    expect(precheck(md, 'Build-CAP', [])).toContain('BAD_SLUG: slug "Build-CAP" must be lowercase')
  })
  it('reports a missing H1', () => {
    const md = `---\nparser: v2\n---\n## not an h1\n`
    expect(precheck(md, 'x', [])).toContain('NO_H1: exactly one "# " H1 title is required (found 0)')
  })
})
