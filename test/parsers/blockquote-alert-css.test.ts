import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = 'hugo/assets/css/sap-fundamental.src.css'
const built = 'hugo/assets/css/sap-fundamental.css'

describe('blockquote alert variant CSS', () => {
  it('source defines all four variant selectors', () => {
    const t = readFileSync(src, 'utf8')
    expect(t).toContain('blockquote.alert-note')
    expect(t).toContain('blockquote.alert-important')
    expect(t).toContain('blockquote.alert-tip')
    expect(t).toContain('blockquote.alert-warning')
    expect(t).toContain('blockquote.alert-caution')
  })

  it('tip maps to Horizon success green, caution to error red, warning to amber', () => {
    const t = readFileSync(src, 'utf8')
    expect(t).toContain('#30914c') // success border
    expect(t).toContain('#f5fae5') // success bg
    expect(t).toContain('#dd6100') // warning border
    expect(t).toContain('#fff8d6') // warning bg
    expect(t).toContain('#e90b0b') // error border
    expect(t).toContain('#ffeaf4') // error bg
  })

  it('built css was regenerated with the variant selectors', () => {
    const t = readFileSync(built, 'utf8')
    expect(t).toContain('.alert-tip')
    expect(t).toContain('.alert-warning')
    expect(t).toContain('.alert-caution')
  })

  it('does not alter the base blockquote default (blue Information still present)', () => {
    const t = readFileSync(src, 'utf8')
    expect(t).toContain('--sapInformationBackground')
  })
})
