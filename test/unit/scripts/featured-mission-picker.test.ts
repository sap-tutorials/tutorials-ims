// Unit tests for pickFeaturedMissions — the homepage-featured-missions picker
// that prefers explicit FeaturedTasks curation over the regex-sieved
// catalog-order fallback (issue #739).

import { describe, it, expect } from 'vitest'
import {
  pickFeaturedMissions,
  type BrowseCardItem,
  FEATURED_MAX,
} from '../../../scripts/fetch-tutorials.js'
import type { BrowseFeaturedEntry } from '../../../scripts/parsers/cap.js'

// Helper to build a synthetic BrowseCardItem with sensible defaults.
function mission(id: string, title: string): BrowseCardItem {
  return {
    type: 'mission',
    id,
    title,
    description: '',
    time: 0,
    level: 'beginner',
    tutorialCount: 0,
    primaryTag: '',
    displayTags: [],
    displayTagSlugs: [],
    href: `/missions/${id}`,
    stepCount: 0,
    categorySlugs: [],
  }
}

describe('pickFeaturedMissions (#739)', () => {
  it('case 1: curated set has mission entries — returns curated slugs in order', () => {
    const all: BrowseCardItem[] = [
      mission('cap-handlers', 'CAP Handlers'),
      mission('btp-onboard', 'BTP Onboarding'),
      mission('hana-cloud', 'HANA Cloud'),
    ]
    const featured: BrowseFeaturedEntry[] = [
      { type: 'mission', slug: 'hana-cloud',  title: '', description: '' },
      { type: 'mission', slug: 'cap-handlers', title: '', description: '' },
    ]
    expect(pickFeaturedMissions(featured, all)).toEqual(['hana-cloud', 'cap-handlers'])
  })

  it('case 2: curated set is empty — falls back to regex-sieved catalog-order top FEATURED_MAX', () => {
    const all: BrowseCardItem[] = [
      mission('cap-handlers', 'CAP Handlers'),
      mission('event-thing',  'Devtoberfest 2025'),    // sieved out by EVENT_MISSION_RE
      mission('btp-onboard',  'BTP Onboarding'),
    ]
    const featured: BrowseFeaturedEntry[] = []
    // Both non-event missions land in the result; sieve drops the Devtoberfest one.
    expect(pickFeaturedMissions(featured, all)).toEqual(['cap-handlers', 'btp-onboard'])
  })

  it('case 3: curated set has only TUTORIAL/GROUP entries — falls back', () => {
    const all: BrowseCardItem[] = [
      mission('cap-handlers', 'CAP Handlers'),
      mission('btp-onboard',  'BTP Onboarding'),
    ]
    const featured: BrowseFeaturedEntry[] = [
      { type: 'tutorial', slug: 'some-tutorial', title: '', description: '' },
      { type: 'group',    slug: 'some-group',    title: '', description: '' },
    ]
    // No missions in curated set → fallback fires.
    expect(pickFeaturedMissions(featured, all)).toEqual(['cap-handlers', 'btp-onboard'])
  })

  it('case 4: curated set has mixed types including missions — returns only mission slugs in order', () => {
    const all: BrowseCardItem[] = [
      mission('cap-handlers', 'CAP Handlers'),
      mission('hana-cloud',   'HANA Cloud'),
    ]
    const featured: BrowseFeaturedEntry[] = [
      { type: 'mission',  slug: 'hana-cloud',   title: '', description: '' },
      { type: 'tutorial', slug: 'some-tutorial', title: '', description: '' },
      { type: 'mission',  slug: 'cap-handlers', title: '', description: '' },
      { type: 'group',    slug: 'some-group',   title: '', description: '' },
    ]
    expect(pickFeaturedMissions(featured, all)).toEqual(['hana-cloud', 'cap-handlers'])
  })

  it('case 5: curated set has 3 missions — returns exactly those 3 slugs (no fallback fill)', () => {
    const all: BrowseCardItem[] = Array.from({ length: 15 }, (_, i) =>
      mission(`mission-${i}`, `Mission ${i}`),
    )
    const featured: BrowseFeaturedEntry[] = [
      { type: 'mission', slug: 'mission-0', title: '', description: '' },
      { type: 'mission', slug: 'mission-1', title: '', description: '' },
      { type: 'mission', slug: 'mission-2', title: '', description: '' },
    ]
    expect(pickFeaturedMissions(featured, all)).toEqual(['mission-0', 'mission-1', 'mission-2'])
  })

  it('case 6: curated set has more than FEATURED_MAX missions — returns first FEATURED_MAX in order', () => {
    const all: BrowseCardItem[] = Array.from({ length: 20 }, (_, i) =>
      mission(`mission-${i}`, `Mission ${i}`),
    )
    const featured: BrowseFeaturedEntry[] = Array.from({ length: 15 }, (_, i) => ({
      type: 'mission' as const,
      slug: `mission-${i}`,
      title: '',
      description: '',
    }))
    const result = pickFeaturedMissions(featured, all)
    expect(result).toHaveLength(FEATURED_MAX)
    expect(result[0]).toBe('mission-0')
    expect(result[FEATURED_MAX - 1]).toBe(`mission-${FEATURED_MAX - 1}`)
  })

  it('case 7: curated set references a slug not in all[] — orphan is filtered out', () => {
    const all: BrowseCardItem[] = [
      mission('cap-handlers', 'CAP Handlers'),
    ]
    const featured: BrowseFeaturedEntry[] = [
      { type: 'mission', slug: 'cap-handlers', title: '', description: '' },
      { type: 'mission', slug: 'orphaned-slug', title: '', description: '' },
    ]
    // Orphan dropped because it isn't in all[].
    expect(pickFeaturedMissions(featured, all)).toEqual(['cap-handlers'])
  })
})
