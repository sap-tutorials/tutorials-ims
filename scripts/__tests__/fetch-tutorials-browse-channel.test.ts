import { describe, it, expect } from 'vitest'
import { browseDataFile, buildAllCards } from '../fetch-tutorials'
import type {
  TutorialNavEntry,
  Mission,
  MissionHierarchy,
  StandaloneGroup,
  CatalogTutorialMeta,
} from '../parsers/types.js'

describe('browseDataFile channel awareness', () => {
  it('writes prod browse.json under hugo/data', () => {
    expect(browseDataFile('prod').replace(/\\/g, '/')).toMatch(/hugo\/data\/browse\.json$/)
  })
  it('writes qa browse.json under hugo/data-qa', () => {
    expect(browseDataFile('qa').replace(/\\/g, '/')).toMatch(/hugo\/data-qa\/browse\.json$/)
  })
})

// ─── Minimal fixture helpers ──────────────────────────────────────────────────

function makeTut(overrides: Partial<TutorialNavEntry> = {}): TutorialNavEntry {
  return {
    slug: 'my-tutorial',
    title: 'My Tutorial',
    description: 'desc',
    time: 10,
    level: 'beginner',
    stepCount: 3,
    primaryTag: 'CAP',
    displayTags: [],
    displayTagSlugs: [],
    prev: null,
    next: null,
    ...overrides,
  }
}

const noMissions: Mission[] = []
const noHierarchies: MissionHierarchy[] = []
const noGroups: StandaloneGroup[] = []
const emptyMetaMap = new Map<string, CatalogTutorialMeta>()

describe('buildAllCards — hrefBase parameter (prod byte-identical + QA)', () => {
  // ── Tutorial cards ────────────────────────────────────────────────────────
  it('default hrefBase emits /tutorials/<slug> for tutorial cards (prod byte-identical)', () => {
    const cards = buildAllCards(
      [makeTut({ slug: 'cap-add-auth' })],
      noMissions, noHierarchies, noGroups, emptyMetaMap,
      // no hrefBase arg → defaults to '/tutorials'
    )
    const tutCard = cards.find(c => c.type === 'tutorial')
    expect(tutCard?.href).toBe('/tutorials/cap-add-auth')
  })

  it('hrefBase=/tutorials-qa emits /tutorials-qa/<slug> for tutorial cards', () => {
    const cards = buildAllCards(
      [makeTut({ slug: 'cap-add-auth' })],
      noMissions, noHierarchies, noGroups, emptyMetaMap,
      '/tutorials-qa',
    )
    const tutCard = cards.find(c => c.type === 'tutorial')
    expect(tutCard?.href).toBe('/tutorials-qa/cap-add-auth')
  })

  // ── Mission cards ─────────────────────────────────────────────────────────
  it('default hrefBase emits /tutorials/mission-<slug> for mission cards (prod byte-identical)', () => {
    const mission: Mission = {
      imsId: 1, slug: 'cap-quickstart', title: 'CAP Quickstart',
      description: '', level: 'beginner', time: 60, icon: '', tasksCount: 3,
    }
    const tut = makeTut({ slug: 'cap-add-auth', missionId: 1, missionTitle: 'CAP Quickstart' })
    const cards = buildAllCards([tut], [mission], noHierarchies, noGroups, emptyMetaMap)
    const mCard = cards.find(c => c.type === 'mission')
    expect(mCard?.href).toBe('/tutorials/mission-cap-quickstart')
  })

  it('hrefBase=/tutorials-qa emits /tutorials-qa/mission-<slug> for mission cards', () => {
    const mission: Mission = {
      imsId: 1, slug: 'cap-quickstart', title: 'CAP Quickstart',
      description: '', level: 'beginner', time: 60, icon: '', tasksCount: 3,
    }
    const tut = makeTut({ slug: 'cap-add-auth', missionId: 1, missionTitle: 'CAP Quickstart' })
    const cards = buildAllCards(
      [tut], [mission], noHierarchies, noGroups, emptyMetaMap,
      '/tutorials-qa',
    )
    const mCard = cards.find(c => c.type === 'mission')
    expect(mCard?.href).toBe('/tutorials-qa/mission-cap-quickstart')
  })

  // ── Group cards ───────────────────────────────────────────────────────────
  it('default hrefBase emits /tutorials/group-<slug> for group cards (prod byte-identical)', () => {
    const hierarchy: MissionHierarchy = {
      missionImsId: 1,
      tutorialSlugs: ['cap-add-auth'],
      groups: [{
        imsId: 10, slug: 'cap-setup', title: 'CAP Setup',
        description: '', tutorialSlugs: ['cap-add-auth'],
      }],
    }
    const tut = makeTut({ slug: 'cap-add-auth', missionId: 1, groupId: 10, groupTitle: 'CAP Setup' })
    const cards = buildAllCards([tut], noMissions, [hierarchy], noGroups, emptyMetaMap)
    const gCard = cards.find(c => c.type === 'group')
    expect(gCard?.href).toBe('/tutorials/group-cap-setup')
  })

  it('hrefBase=/tutorials-qa emits /tutorials-qa/group-<slug> for group cards', () => {
    const hierarchy: MissionHierarchy = {
      missionImsId: 1,
      tutorialSlugs: ['cap-add-auth'],
      groups: [{
        imsId: 10, slug: 'cap-setup', title: 'CAP Setup',
        description: '', tutorialSlugs: ['cap-add-auth'],
      }],
    }
    const tut = makeTut({ slug: 'cap-add-auth', missionId: 1, groupId: 10, groupTitle: 'CAP Setup' })
    const cards = buildAllCards(
      [tut], noMissions, [hierarchy], noGroups, emptyMetaMap,
      '/tutorials-qa',
    )
    const gCard = cards.find(c => c.type === 'group')
    expect(gCard?.href).toBe('/tutorials-qa/group-cap-setup')
  })
})
