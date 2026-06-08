// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { renderToString } from 'vue/server-renderer'
import { createSSRApp, h } from 'vue'
import ProgressOverlay from './ProgressOverlay.vue'
import TutorialCard from './TutorialCard.vue'
import MissionCard from './MissionCard.vue'
import GroupCard from './GroupCard.vue'
import { emptyProgress, type ProgressPayload } from '../../navigator/cardProgress'
import type { CardItem } from '@shared/types'
import { _resetCategoryLabelCache } from './categoryLabel'

const tutorialItem: CardItem = {
  type: 'tutorial',
  id: 't1',
  title: 'A',
  description: '',
  time: 5,
  level: 'beginner',
  tutorialCount: 1,
  primaryTag: '',
  displayTags: [],
  displayTagSlugs: [],
  href: '/tutorials/a',
  stepCount: 3,
}

// Seed inline browse-data JSON before every test so categoryLabel() can
// resolve slugs from the DOM, and bust the module-level cache so tests
// don't bleed into each other.
function seedBrowseData() {
  const existing = document.getElementById('browse-data')
  if (existing) existing.remove()
  const s = document.createElement('script')
  s.id = 'browse-data'
  s.type = 'application/json'
  s.textContent = JSON.stringify({
    categories: [
      { slug: 'artificial-intelligence', label: 'Artificial Intelligence' },
      { slug: 'app-dev-automation', label: 'Application Development & Automation' },
    ],
  })
  document.head.appendChild(s)
}

beforeEach(() => {
  _resetCategoryLabelCache()
  seedBrowseData()
})

describe('<ProgressOverlay>', () => {
  it('renders nothing during SSR even when progress is set', async () => {
    const progress: ProgressPayload = {
      ...emptyProgress(),
      tutorials: {
        completedSlugs: new Set(),
        inProgress: new Map([['a', 33]]),
      },
    }
    const html = await renderToString(
      createSSRApp({
        render: () => h(ProgressOverlay, { item: tutorialItem, progress }),
      })
    )
    expect(html).not.toContain('progress-ring')
  })

  it('renders progress ring on the client when progress exists', async () => {
    const progress: ProgressPayload = {
      ...emptyProgress(),
      tutorials: {
        completedSlugs: new Set(),
        inProgress: new Map([['a', 33]]),
      },
    }
    const wrapper = mount(ProgressOverlay, {
      props: { item: tutorialItem, progress },
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.nav-card__progress').exists()).toBe(true)
  })

  it('renders nothing when there is no progress for this item', async () => {
    const wrapper = mount(ProgressOverlay, {
      props: { item: tutorialItem, progress: emptyProgress() },
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.nav-card__progress').exists()).toBe(false)
  })
})

describe('<TutorialCard>', () => {
  const tut: CardItem = {
    type: 'tutorial',
    id: 'cap-getting-started',
    title: 'CAP Getting Started',
    description: 'Build a CAP service in 30 min',
    time: 30,
    level: 'beginner',
    tutorialCount: 1,
    primaryTag: 'cap',
    displayTags: ['CAP'],
    displayTagSlugs: ['software-product>sap-cloud-application-programming-model'],
    href: '/tutorials/cap-getting-started',
    stepCount: 5,
    isNew: true,
  }

  it('renders title, description, level, time', () => {
    const w = mount(TutorialCard, { props: { item: tut, progress: emptyProgress() } })
    expect(w.text()).toContain('CAP Getting Started')
    expect(w.text()).toContain('Build a CAP service in 30 min')
    expect(w.text()).toContain('Beginner')
    expect(w.text()).toContain('30')
  })

  it('renders the NEW badge when isNew is true', () => {
    const w = mount(TutorialCard, { props: { item: tut, progress: emptyProgress() } })
    expect(w.find('.nav-card__new-badge').exists()).toBe(true)
  })

  it('omits the NEW badge when isNew is false', () => {
    const w = mount(TutorialCard, { props: { item: { ...tut, isNew: false }, progress: emptyProgress() } })
    expect(w.find('.nav-card__new-badge').exists()).toBe(false)
  })

  it('SSR renders without the progress ring even when progress exists', async () => {
    const progress: ProgressPayload = {
      ...emptyProgress(),
      tutorials: {
        completedSlugs: new Set(),
        inProgress: new Map([['cap-getting-started', 33]]),
      },
    }
    const html = await renderToString(createSSRApp({
      render: () => h(TutorialCard, { item: tut, progress }),
    }))
    expect(html).toContain('CAP Getting Started')
    expect(html).not.toContain('nav-card__progress')
  })

  it('href maps to /tutorials/<slug>', () => {
    const w = mount(TutorialCard, { props: { item: tut, progress: emptyProgress() } })
    expect(w.attributes('href')).toBe('/tutorials/cap-getting-started')
  })
})

describe('<MissionCard>', () => {
  const m: CardItem = {
    type: 'mission', id: 'mission-1', title: 'Build with CAP',
    description: 'Full-stack mission', time: 240, level: 'intermediate',
    tutorialCount: 8, primaryTag: 'cap', displayTags: ['CAP'],
    displayTagSlugs: ['software-product>sap-cloud-application-programming-model'],
    href: '/tutorials/mission-build-with-cap', stepCount: 40,
  }
  it('renders type label "MISSION"', () => {
    const w = mount(MissionCard, { props: { item: m, progress: emptyProgress() } })
    expect(w.find('.nav-card__type').text()).toBe('MISSION')
  })
  it('shows tutorial count in meta', () => {
    const w = mount(MissionCard, { props: { item: m, progress: emptyProgress() } })
    expect(w.text()).toContain('8 Tutorials')
  })
  it('href maps to /tutorials/mission-...', () => {
    const w = mount(MissionCard, { props: { item: m, progress: emptyProgress() } })
    expect(w.attributes('href')).toBe('/tutorials/mission-build-with-cap')
  })
})

describe('<GroupCard>', () => {
  const g: CardItem = {
    type: 'group', id: 'group-1', title: 'CAP Basics',
    description: 'Three tutorials', time: 90, level: 'beginner',
    tutorialCount: 3, primaryTag: 'cap', displayTags: [], displayTagSlugs: [],
    href: '/tutorials/group-cap-basics', stepCount: 12,
  }
  it('renders type label "GROUP"', () => {
    const w = mount(GroupCard, { props: { item: g, progress: emptyProgress() } })
    expect(w.find('.nav-card__type').text()).toBe('GROUP')
  })
  it('shows tutorial count in meta', () => {
    const w = mount(GroupCard, { props: { item: g, progress: emptyProgress() } })
    expect(w.text()).toContain('3 Tutorials')
  })
  it('href maps to /tutorials/group-...', () => {
    const w = mount(GroupCard, { props: { item: g, progress: emptyProgress() } })
    expect(w.attributes('href')).toBe('/tutorials/group-cap-basics')
  })
})

// ── Category chip tests ───────────────────────────────────────────────────────

describe('<MissionCard> category chip', () => {
  const base: CardItem = {
    type: 'mission', id: 'mission-1', title: 'Build with CAP',
    description: 'Full-stack mission', time: 240, level: 'intermediate',
    tutorialCount: 8, primaryTag: 'cap', displayTags: ['CAP'],
    displayTagSlugs: ['software-product>sap-cloud-application-programming-model'],
    href: '/tutorials/mission-build-with-cap', stepCount: 40,
  }

  it('renders chip with resolved label when categorySlugs has entries', () => {
    const w = mount(MissionCard, {
      props: { item: { ...base, categorySlugs: ['artificial-intelligence'] }, progress: emptyProgress() },
    })
    expect(w.find('ui5-tag.card-category-chip').exists()).toBe(true)
    expect(w.find('ui5-tag.card-category-chip').text()).toContain('Artificial Intelligence')
  })

  it('renders no chip when categorySlugs is empty', () => {
    const w = mount(MissionCard, {
      props: { item: { ...base, categorySlugs: [] }, progress: emptyProgress() },
    })
    expect(w.find('ui5-tag.card-category-chip').exists()).toBe(false)
  })
})

describe('<GroupCard> category chip', () => {
  const base: CardItem = {
    type: 'group', id: 'group-1', title: 'CAP Basics',
    description: 'Three tutorials', time: 90, level: 'beginner',
    tutorialCount: 3, primaryTag: 'cap', displayTags: [], displayTagSlugs: [],
    href: '/tutorials/group-cap-basics', stepCount: 12,
  }

  it('renders chip with resolved label when categorySlugs has entries', () => {
    const w = mount(GroupCard, {
      props: { item: { ...base, categorySlugs: ['app-dev-automation'] }, progress: emptyProgress() },
    })
    expect(w.find('ui5-tag.card-category-chip').exists()).toBe(true)
    expect(w.find('ui5-tag.card-category-chip').text()).toContain('Application Development & Automation')
  })

  it('renders no chip when categorySlugs is empty', () => {
    const w = mount(GroupCard, {
      props: { item: { ...base, categorySlugs: [] }, progress: emptyProgress() },
    })
    expect(w.find('ui5-tag.card-category-chip').exists()).toBe(false)
  })
})

describe('<TutorialCard> category chip', () => {
  const base: CardItem = {
    type: 'tutorial', id: 'cap-getting-started', title: 'CAP Getting Started',
    description: 'Build a CAP service in 30 min', time: 30, level: 'beginner',
    tutorialCount: 1, primaryTag: 'cap', displayTags: ['CAP'],
    displayTagSlugs: ['software-product>sap-cloud-application-programming-model'],
    href: '/tutorials/cap-getting-started', stepCount: 5, isNew: true,
  }

  it('renders chip with resolved label when categorySlugs has entries', () => {
    const w = mount(TutorialCard, {
      props: { item: { ...base, categorySlugs: ['artificial-intelligence'] }, progress: emptyProgress() },
    })
    expect(w.find('ui5-tag.card-category-chip').exists()).toBe(true)
    expect(w.find('ui5-tag.card-category-chip').text()).toContain('Artificial Intelligence')
  })

  it('renders no chip when categorySlugs is empty', () => {
    const w = mount(TutorialCard, {
      props: { item: { ...base, categorySlugs: [] }, progress: emptyProgress() },
    })
    expect(w.find('ui5-tag.card-category-chip').exists()).toBe(false)
  })
})
