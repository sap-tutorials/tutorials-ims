// hugo-apps/src/shared/composables/__tests__/progress-filter.test.ts
//
// Unit tests for the matchesProgress pure helper (Task 7 — #3112).
// Exercises all predicate modes in isolation without mounting the SFC.
import { describe, it, expect } from 'vitest'
import { matchesProgress } from '../useNavigatorFilters'
import type { CardItem } from '@shared/types'
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
