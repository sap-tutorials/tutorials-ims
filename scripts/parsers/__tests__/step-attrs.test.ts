import { describe, it, expect } from 'vitest'
import { parseStepHeadingAttrs, StepAttrError } from '../step-attrs.js'

describe('parseStepHeadingAttrs', () => {
  it('passes through a plain title unchanged', () => {
    const r = parseStepHeadingAttrs('Deploy the app')
    expect(r).toEqual({ title: 'Deploy the app', warnings: [] })
  })

  it('strips a {time=…} block and reports seconds', () => {
    const r = parseStepHeadingAttrs('Deploy the app {time=5m}')
    expect(r.title).toBe('Deploy the app')
    expect(r.timeSeconds).toBe(300)
    expect(r.optional).toBeUndefined()
    expect(r.warnings).toEqual([])
  })

  it('strips {optional} and sets optional:true', () => {
    const r = parseStepHeadingAttrs('Enable trial {optional}')
    expect(r.title).toBe('Enable trial')
    expect(r.optional).toBe(true)
    expect(r.timeSeconds).toBeUndefined()
  })

  it('accepts both tokens together, any order', () => {
    const a = parseStepHeadingAttrs('Deploy {time=5m optional}')
    expect(a.title).toBe('Deploy')
    expect(a.timeSeconds).toBe(300)
    expect(a.optional).toBe(true)

    const b = parseStepHeadingAttrs('Deploy {optional time=5m}')
    expect(b.title).toBe('Deploy')
    expect(b.timeSeconds).toBe(300)
    expect(b.optional).toBe(true)
  })

  it('parses compound durations: 90s, 1h, 1h30m', () => {
    expect(parseStepHeadingAttrs('S {time=90s}').timeSeconds).toBe(90)
    expect(parseStepHeadingAttrs('S {time=1h}').timeSeconds).toBe(3600)
    expect(parseStepHeadingAttrs('S {time=1h30m}').timeSeconds).toBe(5400)
  })

  it('slug stability: title is identical with/without the attribute block', () => {
    const plain = parseStepHeadingAttrs('Deploy the app')
    const withAttrs = parseStepHeadingAttrs('Deploy the app {time=5m optional}')
    expect(withAttrs.title).toBe(plain.title)
  })

  it('leaves unrecognised braces attached and warns step-attr/unknown', () => {
    const r = parseStepHeadingAttrs('Return {status: ok}')
    expect(r.title).toBe('Return {status: ok}')
    expect(r.timeSeconds).toBeUndefined()
    expect(r.optional).toBeUndefined()
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/^step-attr\/unknown:/)
  })

  it('leaves the WHOLE brace attached when only one token is unrecognised', () => {
    const r = parseStepHeadingAttrs('Deploy {time=5m bogus}')
    expect(r.title).toBe('Deploy {time=5m bogus}')
    expect(r.timeSeconds).toBeUndefined()
    expect(r.warnings).toHaveLength(1)
  })

  it('throws a step-naming error on an invalid duration', () => {
    expect(() => parseStepHeadingAttrs('Deploy the app {time=5x}')).toThrow(StepAttrError)
    try {
      parseStepHeadingAttrs('Deploy the app {time=5x}')
      expect.unreachable()
    } catch (e) {
      expect(String((e as Error).message)).toContain('Deploy the app')
    }
  })

  it('throws on a zero or >8h duration', () => {
    expect(() => parseStepHeadingAttrs('S {time=0m}')).toThrow(StepAttrError)
    expect(() => parseStepHeadingAttrs('S {time=9h}')).toThrow(StepAttrError)
  })

  it('treats empty braces as a no-op strip', () => {
    const r = parseStepHeadingAttrs('Deploy the app {}')
    expect(r.title).toBe('Deploy the app')
    expect(r.warnings).toEqual([])
  })
})
