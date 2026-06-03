// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { renderToString } from 'vue/server-renderer'
import { createSSRApp, h } from 'vue'
import ProgressOverlay from './ProgressOverlay.vue'
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
