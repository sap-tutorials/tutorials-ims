import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { convertBody } from '../convert-body.mjs'

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
