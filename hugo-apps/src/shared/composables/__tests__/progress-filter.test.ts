// @vitest-environment happy-dom
// hugo-apps/src/shared/composables/__tests__/progress-filter.test.ts
//
// Unit tests for the matchesProgress pure helper (Task 7 — #3112) and
// the progressFilterActive server-mode guard (Task 8 — #3112).
// Exercises all predicate modes in isolation without mounting the SFC.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { matchesProgress, useNavigatorFilters } from '../useNavigatorFilters'
import * as useSearchModule from '../../../navigator/useSearch'
import type { CardItem, TutorialEntry } from '@shared/types'
import type { ProgressPayload } from '../../../navigator/cardProgress'

// ─── Test fixtures ───────────────────────────────────────────────────────────

const COMPLETED_TUTORIAL_SLUG = 'cap-service-add-process'
const INPROGRESS_TUTORIAL_SLUG = 'hana-cloud-deploying'
const COMPLETED_MISSION_SLUG = 'cap-service-learn-basics'
const OTHER_TUTORIAL_SLUG = 'abap-environment-create-app'

function makeCards(): CardItem[] {
  return [
    {
      type: 'tutorial',
      id: COMPLETED_TUTORIAL_SLUG,
      title: 'Completed tutorial',
      description: '',
      time: 10,
      level: 'beginner',
      tutorialCount: 1,
      primaryTag: '',
      displayTags: [],
      displayTagSlugs: [],
      href: `/tutorials/${COMPLETED_TUTORIAL_SLUG}`,
      stepCount: 3,
    },
    {
      type: 'tutorial',
      id: INPROGRESS_TUTORIAL_SLUG,
      title: 'In-progress tutorial',
      description: '',
      time: 15,
      level: 'beginner',
      tutorialCount: 1,
      primaryTag: '',
      displayTags: [],
      displayTagSlugs: [],
      href: `/tutorials/${INPROGRESS_TUTORIAL_SLUG}`,
      stepCount: 5,
    },
    {
      type: 'mission',
      id: `mission-${COMPLETED_MISSION_SLUG}`,
      title: 'Completed mission',
      description: '',
      time: 120,
      level: 'beginner',
      tutorialCount: 5,
      primaryTag: '',
      displayTags: [],
      displayTagSlugs: [],
      href: `/tutorials/mission-${COMPLETED_MISSION_SLUG}`,
      stepCount: 20,
    },
    {
      type: 'tutorial',
      id: OTHER_TUTORIAL_SLUG,
      title: 'Untouched tutorial',
      description: '',
      time: 20,
      level: 'intermediate',
      tutorialCount: 1,
      primaryTag: '',
      displayTags: [],
      displayTagSlugs: [],
      href: `/tutorials/${OTHER_TUTORIAL_SLUG}`,
      stepCount: 4,
    },
  ]
}

function makeProgress(): ProgressPayload {
  return {
    authenticated: true,
    tutorials: {
      completedSlugs: new Set([COMPLETED_TUTORIAL_SLUG]),
      inProgress: new Map([[INPROGRESS_TUTORIAL_SLUG, 60]]),
    },
    missionSlugs: new Set([COMPLETED_MISSION_SLUG]),
    groupSlugs: new Set(),
  }
}

const allCards = makeCards()
const progress = makeProgress()

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('matchesProgress', () => {
  describe('neither flag set (pass everything)', () => {
    it('passes all cards when completed and inProgress are both false', () => {
      const flags = { completed: false, inProgress: false }
      const result = allCards.filter(item => matchesProgress(item, flags, progress))
      expect(result).toHaveLength(4)
    })

    it('passes all cards when progress is undefined (no-op)', () => {
      const flags = { completed: false, inProgress: false }
      const result = allCards.filter(item => matchesProgress(item, flags, undefined))
      expect(result).toHaveLength(4)
    })
  })

  describe('completed flag only', () => {
    it('keeps the completed tutorial and the completed mission', () => {
      const flags = { completed: true, inProgress: false }
      const result = allCards.filter(item => matchesProgress(item, flags, progress))
      const ids = result.map(i => i.id).sort()
      expect(ids).toEqual([
        `mission-${COMPLETED_MISSION_SLUG}`,
        COMPLETED_TUTORIAL_SLUG,
      ].sort())
    })

    it('excludes the in-progress tutorial', () => {
      const flags = { completed: true, inProgress: false }
      const result = allCards.filter(item => matchesProgress(item, flags, progress))
      expect(result.find(i => i.id === INPROGRESS_TUTORIAL_SLUG)).toBeUndefined()
    })

    it('excludes untouched items', () => {
      const flags = { completed: true, inProgress: false }
      const result = allCards.filter(item => matchesProgress(item, flags, progress))
      expect(result.find(i => i.id === OTHER_TUTORIAL_SLUG)).toBeUndefined()
    })
  })

  describe('inProgress flag only', () => {
    it('keeps only the in-progress tutorial', () => {
      const flags = { completed: false, inProgress: true }
      const result = allCards.filter(item => matchesProgress(item, flags, progress))
      const ids = result.map(i => i.id)
      expect(ids).toEqual([INPROGRESS_TUTORIAL_SLUG])
    })

    it('excludes the completed tutorial (binary completed, not inProgress)', () => {
      const flags = { completed: false, inProgress: true }
      const result = allCards.filter(item => matchesProgress(item, flags, progress))
      expect(result.find(i => i.id === COMPLETED_TUTORIAL_SLUG)).toBeUndefined()
    })

    it('excludes the completed mission (missions are binary — complete or null, never inProgress)', () => {
      const flags = { completed: false, inProgress: true }
      const result = allCards.filter(item => matchesProgress(item, flags, progress))
      expect(result.find(i => i.id === `mission-${COMPLETED_MISSION_SLUG}`)).toBeUndefined()
    })
  })

  describe('both flags set (union)', () => {
    it('returns union: completed tutorial + in-progress tutorial + completed mission', () => {
      const flags = { completed: true, inProgress: true }
      const result = allCards.filter(item => matchesProgress(item, flags, progress))
      const ids = result.map(i => i.id).sort()
      expect(ids).toEqual([
        COMPLETED_TUTORIAL_SLUG,
        INPROGRESS_TUTORIAL_SLUG,
        `mission-${COMPLETED_MISSION_SLUG}`,
      ].sort())
    })

    it('excludes the untouched tutorial even in union mode', () => {
      const flags = { completed: true, inProgress: true }
      const result = allCards.filter(item => matchesProgress(item, flags, progress))
      expect(result.find(i => i.id === OTHER_TUTORIAL_SLUG)).toBeUndefined()
    })
  })

  describe('progress undefined (no-op regardless of flags)', () => {
    it('passes all cards when progress is undefined even if completed=true', () => {
      const flags = { completed: true, inProgress: false }
      const result = allCards.filter(item => matchesProgress(item, flags, undefined))
      expect(result).toHaveLength(4)
    })

    it('passes all cards when progress is undefined even if inProgress=true', () => {
      const flags = { completed: false, inProgress: true }
      const result = allCards.filter(item => matchesProgress(item, flags, undefined))
      expect(result).toHaveLength(4)
    })

    it('passes all cards when progress is undefined even if both flags are true', () => {
      const flags = { completed: true, inProgress: true }
      const result = allCards.filter(item => matchesProgress(item, flags, undefined))
      expect(result).toHaveLength(4)
    })
  })

  describe('empty progress object (all sets/maps empty)', () => {
    const emptyProg: ProgressPayload = {
      authenticated: true,
      tutorials: { completedSlugs: new Set(), inProgress: new Map() },
      missionSlugs: new Set(),
      groupSlugs: new Set(),
    }

    it('returns nothing when completed=true and there is no progress data', () => {
      const result = allCards.filter(item =>
        matchesProgress(item, { completed: true, inProgress: false }, emptyProg)
      )
      expect(result).toHaveLength(0)
    })

    it('returns nothing when inProgress=true and there is no progress data', () => {
      const result = allCards.filter(item =>
        matchesProgress(item, { completed: false, inProgress: true }, emptyProg)
      )
      expect(result).toHaveLength(0)
    })
  })
})

// ─── Task 8: progressFilterActive forces client-filter path ──────────────────
//
// When a progress toggle (completed|inProgress) is active for an authenticated
// user, displayedItems / displayedTotalCount / displayedCounts / totalPages MUST
// take the CLIENT path (filteredItems), not the server searchResults path —
// so counts/pagination are exact and honest.
//
// Setup: mock useSearch to return searchMode=true + fake searchResults (slugs
// that DON'T match the progress data) + searchTotalCount=50, so we can tell
// whether the server path was taken.

describe('progressFilterActive — server-mode guard (Task 8)', () => {
  // Tutorials fixture: one entry so `!!tutorials` is truthy in the guard
  const tutorials = ref<TutorialEntry[]>([
    {
      slug: COMPLETED_TUTORIAL_SLUG,
      title: 'Completed HANA tutorial',
      description: 'hana desc',
      time: 10,
      level: 'beginner',
      stepCount: 3,
      primaryTag: '',
      displayTags: [],
      displayTagSlugs: [],
      prev: null,
      next: null,
    },
  ])

  // allCards: completed tutorial (has 'hana' in title) + one unrelated card
  // The HANA card is the only one that satisfies BOTH the searchQuery('hana') substring AND completed.
  const allCardsForSearch = ref<CardItem[]>([
    {
      type: 'tutorial',
      id: COMPLETED_TUTORIAL_SLUG,
      title: 'Completed HANA tutorial',
      description: '',
      time: 10,
      level: 'beginner',
      tutorialCount: 1,
      primaryTag: '',
      displayTags: [],
      displayTagSlugs: [],
      href: `/tutorials/${COMPLETED_TUTORIAL_SLUG}`,
      stepCount: 3,
    },
    {
      type: 'tutorial',
      id: OTHER_TUTORIAL_SLUG,
      title: 'Untouched tutorial',
      description: '',
      time: 20,
      level: 'intermediate',
      tutorialCount: 1,
      primaryTag: '',
      displayTags: [],
      displayTagSlugs: [],
      href: `/tutorials/${OTHER_TUTORIAL_SLUG}`,
      stepCount: 4,
    },
  ])

  // Server returns a fake result set — different slugs from what the client would return.
  // If displayedItems takes the SERVER path, we'd see this; if CLIENT, we'd see filteredItems.
  const fakeServerResults: CardItem[] = [
    {
      type: 'tutorial',
      id: 'server-only-slug',
      title: 'Server HANA result',
      description: '',
      time: 5,
      level: 'beginner',
      tutorialCount: 1,
      primaryTag: '',
      displayTags: [],
      displayTagSlugs: [],
      href: '/tutorials/server-only-slug',
      stepCount: 2,
    },
  ]

  let executeSearchSpy: ReturnType<typeof vi.fn>
  let useSearchSpy: ReturnType<typeof vi.spyOn>

  function mountWithProgress(progressPayload: ProgressPayload) {
    executeSearchSpy = vi.fn()
    useSearchSpy = vi.spyOn(useSearchModule, 'useSearch').mockReturnValue({
      searchMode: ref(true),
      isSubThreshold: ref(false),
      searchResults: ref(fakeServerResults),
      searchFacets: ref({
        typeCounts: [
          { name: 'TUTORIAL', count: 50 },
          { name: 'MISSION', count: 5 },
          { name: 'GROUP', count: 3 },
        ],
        topProductTags: [],
        topTopicTags: [],
      }),
      searchTotalCount: ref(50),
      isSearching: ref(false),
      searchError: ref(null),
      executeSearch: executeSearchSpy,
    } as unknown as ReturnType<typeof useSearchModule.useSearch>)

    return useNavigatorFilters({
      allCards: allCardsForSearch,
      tutorials,
      syncURL: false,
      progress: ref(progressPayload),
    })
  }

  afterEach(() => {
    useSearchSpy?.mockRestore()
  })

  describe('authenticated user with completed=true + searchQuery="hana"', () => {
    it('displayedItems comes from the CLIENT path (not server searchResults)', async () => {
      const progressPayload: ProgressPayload = {
        authenticated: true,
        tutorials: {
          completedSlugs: new Set([COMPLETED_TUTORIAL_SLUG]),
          inProgress: new Map(),
        },
        missionSlugs: new Set(),
        groupSlugs: new Set(),
      }
      const f = mountWithProgress(progressPayload)
      f.filters.completed = true
      f.searchQuery.value = 'hana'
      await nextTick()

      // CLIENT path: only the completed HANA card matches (search substring 'hana' + completed)
      // SERVER path would return fakeServerResults (id='server-only-slug')
      const ids = f.displayedItems.value.map(i => i.id)
      expect(ids).not.toContain('server-only-slug')
      expect(ids).toContain(COMPLETED_TUTORIAL_SLUG)
    })

    it('displayedTotalCount equals client filteredItems.length (not server searchTotalCount=50)', async () => {
      const progressPayload: ProgressPayload = {
        authenticated: true,
        tutorials: {
          completedSlugs: new Set([COMPLETED_TUTORIAL_SLUG]),
          inProgress: new Map(),
        },
        missionSlugs: new Set(),
        groupSlugs: new Set(),
      }
      const f = mountWithProgress(progressPayload)
      f.filters.completed = true
      f.searchQuery.value = 'hana'
      await nextTick()

      // Server path would return searchTotalCount=50; client path returns filteredItems.length=1
      expect(f.displayedTotalCount.value).toBe(1)
      expect(f.displayedTotalCount.value).not.toBe(50)
    })

    it('displayedCounts comes from client counts (not server facets)', async () => {
      const progressPayload: ProgressPayload = {
        authenticated: true,
        tutorials: {
          completedSlugs: new Set([COMPLETED_TUTORIAL_SLUG]),
          inProgress: new Map(),
        },
        missionSlugs: new Set(),
        groupSlugs: new Set(),
      }
      const f = mountWithProgress(progressPayload)
      f.filters.completed = true
      f.searchQuery.value = 'hana'
      await nextTick()

      // Server facets say: tutorials=50, missions=5, groups=3
      // Client counts: 1 tutorial (the completed HANA one), 0 missions, 0 groups
      expect(f.displayedCounts.value.tutorials).toBe(1)
      expect(f.displayedCounts.value.missions).toBe(0)
      expect(f.displayedCounts.value.groups).toBe(0)
      expect(f.displayedCounts.value.tutorials).not.toBe(50)
    })
  })

  describe('authenticated user with completed=false (progress toggle OFF)', () => {
    it('displayedItems comes from SERVER path when progress toggle is off', async () => {
      const progressPayload: ProgressPayload = {
        authenticated: true,
        tutorials: {
          completedSlugs: new Set([COMPLETED_TUTORIAL_SLUG]),
          inProgress: new Map(),
        },
        missionSlugs: new Set(),
        groupSlugs: new Set(),
      }
      const f = mountWithProgress(progressPayload)
      // completed stays false (default)
      f.searchQuery.value = 'hana'
      await nextTick()

      // Server path: fakeServerResults
      const ids = f.displayedItems.value.map(i => i.id)
      expect(ids).toContain('server-only-slug')
    })

    it('displayedTotalCount uses server searchTotalCount=50 when progress toggle is off', async () => {
      const progressPayload: ProgressPayload = {
        authenticated: true,
        tutorials: {
          completedSlugs: new Set([COMPLETED_TUTORIAL_SLUG]),
          inProgress: new Map(),
        },
        missionSlugs: new Set(),
        groupSlugs: new Set(),
      }
      const f = mountWithProgress(progressPayload)
      f.searchQuery.value = 'hana'
      await nextTick()

      expect(f.displayedTotalCount.value).toBe(50)
    })
  })

  describe('anonymous user (authenticated=false) with progress flag', () => {
    it('progressFilterActive is false for unauthenticated users — uses SERVER path', async () => {
      const anonProgress: ProgressPayload = {
        authenticated: false,
        tutorials: {
          completedSlugs: new Set(),
          inProgress: new Map(),
        },
        missionSlugs: new Set(),
        groupSlugs: new Set(),
      }
      const f = mountWithProgress(anonProgress)
      f.filters.completed = true
      f.searchQuery.value = 'hana'
      await nextTick()

      // Anonymous: progressFilterActive must be false, so server path remains active
      const ids = f.displayedItems.value.map(i => i.id)
      expect(ids).toContain('server-only-slug')
    })

    it('displayedTotalCount uses server searchTotalCount=50 for anonymous users', async () => {
      const anonProgress: ProgressPayload = {
        authenticated: false,
        tutorials: {
          completedSlugs: new Set(),
          inProgress: new Map(),
        },
        missionSlugs: new Set(),
        groupSlugs: new Set(),
      }
      const f = mountWithProgress(anonProgress)
      f.filters.completed = true
      f.searchQuery.value = 'hana'
      await nextTick()

      expect(f.displayedTotalCount.value).toBe(50)
    })
  })
})
