import { describe, it, expect } from 'vitest'
import { requiresLicense, visibleTags, LICENSE_SLUG } from './license'

describe('requiresLicense', () => {
  it('detects license via raw slug, not human label', () => {
    expect(requiresLicense({
      displayTags: ['SAP CAP', 'License'],
      displayTagSlugs: ['software-product>sap-cap', 'tutorial>license'],
    })).toBe(true)
  })

  it('returns false for tutorials without the license slug', () => {
    expect(requiresLicense({
      displayTags: ['SAP CAP'],
      displayTagSlugs: ['software-product>sap-cap'],
    })).toBe(false)
  })

  it('does not false-positive on a tag whose label happens to equal "License"', () => {
    // The whole point of slug-based detection: a custom tag labeled "License"
    // (slug like "software-product>license-manager") should NOT trigger.
    expect(requiresLicense({
      displayTags: ['License Manager'],
      displayTagSlugs: ['software-product>license-manager'],
    })).toBe(false)
  })

  it('returns false on empty input', () => {
    expect(requiresLicense({ displayTags: [], displayTagSlugs: [] })).toBe(false)
  })

  it('returns true when license slug is present alongside other tags', () => {
    expect(requiresLicense({
      displayTags: ['SAP Build', 'License', 'Beginner'],
      displayTagSlugs: ['software-product>sap-build', 'tutorial>license', 'tutorial>beginner'],
    })).toBe(true)
  })
})

describe('visibleTags', () => {
  it('hides the license tag from the visible label list', () => {
    expect(visibleTags({
      displayTags: ['SAP CAP', 'License'],
      displayTagSlugs: ['software-product>sap-cap', 'tutorial>license'],
    })).toEqual(['SAP CAP'])
  })

  it('returns all labels when no license slug present', () => {
    expect(visibleTags({
      displayTags: ['SAP Build', 'Beginner'],
      displayTagSlugs: ['software-product>sap-build', 'tutorial>beginner'],
    })).toEqual(['SAP Build', 'Beginner'])
  })

  it('preserves order of non-license tags', () => {
    expect(visibleTags({
      displayTags: ['A', 'License', 'B', 'C'],
      displayTagSlugs: ['tag>a', 'tutorial>license', 'tag>b', 'tag>c'],
    })).toEqual(['A', 'B', 'C'])
  })

  it('handles empty input', () => {
    expect(visibleTags({ displayTags: [], displayTagSlugs: [] })).toEqual([])
  })

  it('keeps "License Manager" label (different slug) visible', () => {
    expect(visibleTags({
      displayTags: ['License Manager'],
      displayTagSlugs: ['software-product>license-manager'],
    })).toEqual(['License Manager'])
  })
})

describe('LICENSE_SLUG', () => {
  it('exports LICENSE_SLUG as the canonical join key', () => {
    expect(LICENSE_SLUG).toBe('tutorial>license')
  })
})
