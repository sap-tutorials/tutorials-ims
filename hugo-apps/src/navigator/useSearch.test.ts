import { describe, it, expect } from 'vitest'
import { mapToCardItem } from './useSearch'
import type { SearchableItem, TutorialEntry, CardItem } from '@shared/types'

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

import { buildFilter, postFilterNoLicense, buildFacetsUrl } from './useSearch'

describe('buildFilter', () => {
  it('returns empty string with no flags or filters', () => {
    expect(buildFilter([], [], [], { isNew: false, isNewCutoffISO: '' })).toBe('')
  })

  it('omits createdAt clause when isNew is false', () => {
    const out = buildFilter(['TUTORIAL'], [], [], { isNew: false, isNewCutoffISO: '2026-05-01T00:00:00.000Z' })
    expect(out).not.toContain('createdAt')
  })

  it('appends createdAt gt <ISO> when isNew is true', () => {
    const out = buildFilter([], [], [], { isNew: true, isNewCutoffISO: '2026-05-01T00:00:00.000Z' })
    expect(out).toBe("createdAt gt 2026-05-01T00:00:00.000Z")
  })

  it('AND-joins createdAt with other clauses', () => {
    const out = buildFilter(['TUTORIAL'], ['beginner'], [], { isNew: true, isNewCutoffISO: '2026-05-01T00:00:00.000Z' })
    // Order: types, levels, products, then createdAt.
    expect(out).toBe("taskType eq 'TUTORIAL' and experienceTag eq 'beginner' and createdAt gt 2026-05-01T00:00:00.000Z")
  })

  it('does not append createdAt clause when isNewCutoffISO is empty', () => {
    // Defensive contract: the gate is `flags.isNew && flags.isNewCutoffISO`
    // — both must be truthy. The .ts callsite always provides a non-empty
    // ISO when isNew is true, but the helper guards against misuse.
    const out = buildFilter([], [], [], { isNew: true, isNewCutoffISO: '' })
    expect(out).toBe('')
  })
})

describe('buildFacetsUrl', () => {
  // Regression: issue #869 — the previous URL builder inlined an OData
  // v2 collection literal (`taskTypes=['TUTORIAL']`, single quotes) which
  // CAP v4 parses as an invalid enum value and returns HTTP 400. The
  // parallel `fetch` in useSearch treated any facets failure as a total
  // search failure, so the entire navigator page showed "no results" even
  // when SearchableItems returned 210 rows.

  it('uses parameter aliases so array literals are valid OData V4 JSON', () => {
    const url = buildFacetsUrl('abap', ['TUTORIAL'], ['beginner'])
    // Path portion: aliases, no inline literals.
    expect(url.startsWith('/search/getFacets(search=@s,taskTypes=@t,experience=@e)?')).toBe(true)
    // Aliases carry JSON — arrays have double-quoted strings.
    const q = new URLSearchParams(url.split('?')[1])
    expect(JSON.parse(q.get('@s')!)).toBe('abap')
    expect(JSON.parse(q.get('@t')!)).toEqual(['TUTORIAL'])
    expect(JSON.parse(q.get('@e')!)).toEqual(['beginner'])
  })

  it('omits taskTypes/experience aliases when arrays are empty', () => {
    const url = buildFacetsUrl('abap', [], [])
    expect(url).toBe(`/search/getFacets(search=@s)?${new URLSearchParams({ '@s': '"abap"' })}`)
  })

  it('upper-cases task types to match the enum in the SearchableItems view', () => {
    const url = buildFacetsUrl('x', ['tutorial', 'mission'], [])
    const q = new URLSearchParams(url.split('?')[1])
    expect(JSON.parse(q.get('@t')!)).toEqual(['TUTORIAL', 'MISSION'])
  })

  it('safely encodes single-quoted search terms', () => {
    // Previous builder called escOData('O''Reilly'), producing `O''''Reilly`
    // inside an OData string literal — plus URL-encoding on top. With
    // aliases we just JSON-encode the term and let URLSearchParams handle
    // the URL layer.
    const url = buildFacetsUrl("O'Reilly", [], [])
    const q = new URLSearchParams(url.split('?')[1])
    expect(JSON.parse(q.get('@s')!)).toBe("O'Reilly")
  })
})

describe('postFilterNoLicense', () => {
  const licensed: CardItem = {
    type: 'tutorial',
    id: 'a',
    title: 'L',
    description: '',
    time: 0,
    level: 'beginner',
    tutorialCount: 1,
    primaryTag: '',
    displayTags: ['License'],
    displayTagSlugs: ['tutorial>license'],
    href: '/tutorials/a',
    stepCount: 0,
  }
  const free: CardItem = {
    ...licensed,
    id: 'b',
    displayTags: [],
    displayTagSlugs: [],
    href: '/tutorials/b',
  }

  it('returns the input unchanged when noLicense is false', () => {
    expect(postFilterNoLicense([licensed, free], false)).toEqual([licensed, free])
  })

  it('strips license-tagged items when noLicense is true', () => {
    expect(postFilterNoLicense([licensed, free], true)).toEqual([free])
  })

  it('keeps items with no displayTagSlugs', () => {
    expect(postFilterNoLicense([free], true)).toEqual([free])
  })
})
