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
