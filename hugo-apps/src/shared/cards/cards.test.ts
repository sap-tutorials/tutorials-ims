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

// ────────────────────────────────────────────────────────────────────────
// Regression: issue #399 — ring presence must not change content geometry.
// Before the fix: `.nav-card--has-progress` added `padding-left: 3rem`
// to .nav-card__type/__title/__desc, making ringed cards' content area
// 3rem narrower than non-ringed neighbors and breaking horizontal grid
// alignment. Fix: ring moves to top-right, the conditional padding rule
// is deleted, and one collision rule shifts the license icon when both
// license + ring are present on a tutorial card.
//
// We assert against the card.css SOURCE directly because Vitest does not
// apply imported CSS to happy-dom (Vite stubs side-effect CSS imports in
// the test runner). The shape of the rules is the contract; getComputed-
// Style would tautologically pass with no styles applied.
// ────────────────────────────────────────────────────────────────────────
describe('issue #399: ring presence does not shift content', () => {
  // Lazy import via Node fs so we read the file as text without going
  // through Vite's CSS transformer.
  let cardCss: string
  beforeEach(async () => {
    if (!cardCss) {
      const fs = await import('node:fs')
      const path = await import('node:path')
      // Vitest runs from the project root (or hugo-apps when --root is set).
      // Resolve relative to cwd, falling back through both layouts.
      const candidates = [
        path.resolve(process.cwd(), 'hugo-apps/src/shared/cards/card.css'),
        path.resolve(process.cwd(), 'src/shared/cards/card.css'),
      ]
      const found = candidates.find((p) => fs.existsSync(p))
      if (!found) {
        throw new Error('card.css not found from cwd=' + process.cwd() + '; tried: ' + candidates.join(', '))
      }
      cardCss = fs.readFileSync(found, 'utf-8')
    }
  })

  it('does NOT contain the legacy `.nav-card--has-progress` padding-left rule', () => {
    // Bug: this rule made ringed cards' content area 3rem narrower than
    // their neighbors. The fix deletes it.
    expect(cardCss).not.toMatch(/\.nav-card--has-progress\s+\.nav-card__type[^{]*\{[^}]*padding-left/s)
    expect(cardCss).not.toMatch(/\.nav-card--has-progress\s+\.nav-card__title[^{]*\{[^}]*padding-left/s)
    expect(cardCss).not.toMatch(/\.nav-card--has-progress\s+\.nav-card__desc[^{]*\{[^}]*padding-left/s)
  })

  it('positions the progress overlay at right, not left', () => {
    // Find the rule body for the ring overlay. The selector is intentionally
    // specific (`.nav-card .progress-ring.nav-card__progress`, 0,3,0) to beat
    // ProgressRing.vue's scoped `<style scoped>` rule
    // `.progress-ring[data-v-XXX] { position: relative }` which is 0,2,0.
    // A plain `.nav-card__progress { ... }` (0,1,0) loses the cascade and
    // leaves the ring at `position: relative` — see #399 follow-up
    // 2026-06-20 (Playwright reproduction on the deployed DEV approuter).
    const m = cardCss.match(/\.nav-card\s+\.progress-ring\.nav-card__progress\s*\{([^}]*)\}/)
    expect(m, 'expected a `.nav-card .progress-ring.nav-card__progress` rule').not.toBeNull()
    const body = (m![1] || '').replace(/\s+/g, ' ')
    expect(body).toMatch(/position:\s*absolute/)
    expect(body).toMatch(/right:\s*0\.75rem/)
    expect(body).not.toMatch(/(?:^|[\s;])left:\s*0\.75rem/)
  })

  it('uses a 0,3,0+ specificity selector for the overlay (beats ProgressRing\'s scoped 0,2,0)', () => {
    // Defends against a future refactor that simplifies the selector down to
    // `.nav-card__progress { ... }` (0,1,0) — which loses the cascade against
    // ProgressRing.vue's scoped `.progress-ring[data-v-XXX]` (0,2,0) and
    // silently re-introduces the #399 bug.
    expect(cardCss).not.toMatch(/^\s*\.nav-card__progress\s*\{[^}]*position:\s*absolute/m)
    expect(cardCss).toMatch(/\.nav-card\s+\.progress-ring\.nav-card__progress\s*\{/)
  })

  it('shifts the license icon left when a ring is also present', () => {
    // Tutorial cards may have both a license icon and a progress ring.
    // The collision rule moves the license to right: 3.75rem so the two
    // sit side-by-side at the top-right corner.
    expect(cardCss).toMatch(
      /\.nav-card--has-progress\s+\.nav-card__license\s*\{[^}]*right:\s*3\.75rem/s
    )
  })
})
