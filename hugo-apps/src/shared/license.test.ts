import { describe, it, expect } from 'vitest'
import { requiresLicense, visibleTags } from './license'

describe('requiresLicense', () => {
  it('returns true when displayTags contains "License"', () => {
    expect(requiresLicense(['SAP Build', 'License', 'Beginner'])).toBe(true)
  })

  it('returns false when displayTags does not contain "License"', () => {
    expect(requiresLicense(['SAP Build', 'Beginner'])).toBe(false)
  })

  it('returns false on empty input', () => {
    expect(requiresLicense([])).toBe(false)
  })

  it('is case-sensitive (humanizer always produces "License")', () => {
    expect(requiresLicense(['license'])).toBe(false)
    expect(requiresLicense(['LICENSE'])).toBe(false)
  })
})

describe('visibleTags', () => {
  it('removes the literal "License" entry', () => {
    expect(visibleTags(['SAP Build', 'License', 'Beginner']))
      .toEqual(['SAP Build', 'Beginner'])
  })

  it('returns the input unchanged when no License entry', () => {
    expect(visibleTags(['SAP Build', 'Beginner']))
      .toEqual(['SAP Build', 'Beginner'])
  })

  it('preserves order', () => {
    expect(visibleTags(['A', 'License', 'B', 'C']))
      .toEqual(['A', 'B', 'C'])
  })

  it('handles empty input', () => {
    expect(visibleTags([])).toEqual([])
  })
})
