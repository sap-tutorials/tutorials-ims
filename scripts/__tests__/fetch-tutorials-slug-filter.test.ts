import { describe, it, expect } from 'vitest'
import { parseSlugFilter } from '../fetch-tutorials'

describe('parseSlugFilter', () => {
  it('returns null when both inputs are empty/undefined', () => {
    expect(parseSlugFilter()).toBeNull()
    expect(parseSlugFilter('', '')).toBeNull()
    expect(parseSlugFilter(undefined, undefined)).toBeNull()
    expect(parseSlugFilter('   ', '  ,  ,  ')).toBeNull()
  })

  it('returns a 1-element Set for a single `slug` (back-compat)', () => {
    const filter = parseSlugFilter('foo', '')
    expect(filter).toBeInstanceOf(Set)
    expect(filter!.size).toBe(1)
    expect(filter!.has('foo')).toBe(true)
  })

  it('parses comma-separated `slugs` into a multi-element Set', () => {
    const filter = parseSlugFilter('', 'foo,bar,baz')
    expect(filter!.size).toBe(3)
    expect([...filter!].sort()).toEqual(['bar', 'baz', 'foo'])
  })

  it('tolerates spaces around commas: `foo, bar , baz`', () => {
    const filter = parseSlugFilter('', 'foo, bar , baz')
    expect(filter!.size).toBe(3)
    expect(filter!.has('foo')).toBe(true)
    expect(filter!.has('bar')).toBe(true)
    expect(filter!.has('baz')).toBe(true)
  })

  it('drops empty tokens: `foo,, bar`', () => {
    const filter = parseSlugFilter('', 'foo,, bar')
    expect(filter!.size).toBe(2)
    expect(filter!.has('foo')).toBe(true)
    expect(filter!.has('bar')).toBe(true)
  })

  it('unions both `slug` and `slugs` when both are provided', () => {
    const filter = parseSlugFilter('alpha', 'beta,gamma')
    expect(filter!.size).toBe(3)
    expect(filter!.has('alpha')).toBe(true)
    expect(filter!.has('beta')).toBe(true)
    expect(filter!.has('gamma')).toBe(true)
  })

  it('dedupes when `slug` overlaps with `slugs`', () => {
    const filter = parseSlugFilter('foo', 'foo,bar')
    expect(filter!.size).toBe(2)
    expect(filter!.has('foo')).toBe(true)
    expect(filter!.has('bar')).toBe(true)
  })

  it('trims whitespace inside `slug` too', () => {
    const filter = parseSlugFilter('  foo  ', '')
    expect(filter!.size).toBe(1)
    expect(filter!.has('foo')).toBe(true)
  })
})
