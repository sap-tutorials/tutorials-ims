// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import GoalCompletion from './GoalCompletion.vue'

function mockProgress(json: any) {
  return vi.fn(async (url: string) => {
    if (url.includes('/build/my-progress')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => json,
      } as any
    }
    return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({}) } as any
  })
}

const SLUGS = ['tut-a', 'tut-b', 'tut-c', 'tut-d']

describe('GoalCompletion island', () => {
  beforeEach(() => { document.documentElement.setAttribute('data-page-slug', 'mission-foo') })

  it('renders nothing for an anonymous user', async () => {
    global.fetch = mockProgress({ authenticated: false, tutorials: { completedSlugs: [] } })
    const w = mount(GoalCompletion, { props: { tutorialSlugs: SLUGS } })
    await flushPromises()
    expect(w.html().trim()).toBe('<!--v-if-->')
  })

  it('renders "X of Y tutorials complete" with a partial bar for an in-progress goal', async () => {
    global.fetch = mockProgress({
      authenticated: true,
      tutorials: { completedSlugs: ['tut-a', 'tut-b'] },
    })
    const w = mount(GoalCompletion, { props: { tutorialSlugs: SLUGS } })
    await flushPromises()
    expect(w.text()).toContain('2 of 4 tutorials complete')
    // progress bar fill reflects 50%
    const fill = w.find('.goal-completion__bar-fill')
    expect(fill.exists()).toBe(true)
    expect(fill.attributes('style')).toContain('width: 50%')
    // not the completed state
    expect(w.text()).not.toContain('Completed')
  })

  it('renders a Completed badge when every tutorial is done', async () => {
    global.fetch = mockProgress({
      authenticated: true,
      tutorials: { completedSlugs: SLUGS },
    })
    const w = mount(GoalCompletion, { props: { tutorialSlugs: SLUGS } })
    await flushPromises()
    expect(w.text()).toContain('Completed')
    expect(w.find('.goal-completion--complete').exists()).toBe(true)
  })

  it('renders a zero-progress bar for a signed-in user who has done nothing', async () => {
    global.fetch = mockProgress({ authenticated: true, tutorials: { completedSlugs: [] } })
    const w = mount(GoalCompletion, { props: { tutorialSlugs: SLUGS } })
    await flushPromises()
    expect(w.text()).toContain('0 of 4 tutorials complete')
    expect(w.find('.goal-completion__bar-fill').attributes('style')).toContain('width: 0%')
  })

  it('renders nothing when the goal has no tutorials', async () => {
    global.fetch = mockProgress({ authenticated: true, tutorials: { completedSlugs: [] } })
    const w = mount(GoalCompletion, { props: { tutorialSlugs: [] } })
    await flushPromises()
    expect(w.html().trim()).toBe('<!--v-if-->')
  })

  it('fails open and renders nothing when my-progress errors', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network') })
    const w = mount(GoalCompletion, { props: { tutorialSlugs: SLUGS } })
    await flushPromises()
    expect(w.html().trim()).toBe('<!--v-if-->')
  })
})
