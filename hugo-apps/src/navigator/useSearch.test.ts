import { describe, it, expect } from 'vitest'
import { mapToCardItem } from './useSearch'
import type { SearchableItem, TutorialEntry } from '@shared/types'

const baseItem: SearchableItem = {
  ID: 'abc',
  legacyId: 1,
  title: 'Set Up Trust',
  description: 'desc',
  slug: 'cp-cf-trust-iaas',
  primaryTag: 'ABAP Development',
  experienceTag: 'beginner',
  averageTimeToComplete: 25,
  status: 'PUBLISHED',
  taskType: 'TUTORIAL',
}

const baseTutorial: TutorialEntry = {
  slug: 'cp-cf-trust-iaas',
  title: 'Set Up Trust',
  description: 'desc',
  time: 25,
  level: 'beginner',
  stepCount: 5,
  primaryTag: 'ABAP Development',
  displayTags: ['ABAP Development', 'Beginner', 'License', 'SAP BTP'],
  displayTagSlugs: ['software-product>abap-development', 'tutorial>beginner', 'tutorial>license', 'software-product>sap-business-technology-platform'],
  prev: null,
  next: null,
}

describe('mapToCardItem', () => {
  it('preserves License tag when search result slug matches _nav.json entry', () => {
    const lookup = new Map([[baseTutorial.slug, baseTutorial]])
    const card = mapToCardItem(baseItem, lookup)
    expect(card.displayTags).toContain('License')
    expect(card.displayTags).toEqual(baseTutorial.displayTags)
  })

  it('propagates displayTagSlugs from enriched entry', () => {
    const lookup = new Map([[baseTutorial.slug, baseTutorial]])
    const card = mapToCardItem(baseItem, lookup)
    expect(card.displayTagSlugs).toEqual(baseTutorial.displayTagSlugs)
  })

  it('falls back to [primaryTag] when no lookup is provided', () => {
    const card = mapToCardItem(baseItem)
    expect(card.displayTags).toEqual(['ABAP Development'])
    expect(card.displayTagSlugs).toEqual(['ABAP Development'])
  })

  it('falls back to [primaryTag] when slug is missing from lookup', () => {
    const card = mapToCardItem(baseItem, new Map())
    expect(card.displayTags).toEqual(['ABAP Development'])
    expect(card.displayTagSlugs).toEqual(['ABAP Development'])
  })

  it('falls back to [primaryTag] when lookup entry has empty displayTags', () => {
    const lookup = new Map([[baseTutorial.slug, { ...baseTutorial, displayTags: [], displayTagSlugs: [] }]])
    const card = mapToCardItem(baseItem, lookup)
    expect(card.displayTags).toEqual(['ABAP Development'])
    expect(card.displayTagSlugs).toEqual(['ABAP Development'])
  })
})
