// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { renderToString } from 'vue/server-renderer'
import { createSSRApp, h } from 'vue'
import ProgressOverlay from './ProgressOverlay.vue'
import TutorialCard from './TutorialCard.vue'
import { emptyProgress, type ProgressPayload } from '../../navigator/cardProgress'
import type { CardItem } from '@shared/types'

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
