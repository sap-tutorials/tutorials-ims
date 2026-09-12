// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import LearningPath from './LearningPath.vue'

function mockFetch(map: Record<string, { status?: number; json?: any }>) {
  return vi.fn(async (url: string) => {
    const hit = Object.keys(map).find(k => url.includes(k))
    const r = hit ? map[hit] : { status: 404 }
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: { get: () => 'application/json' },
      json: async () => r.json ?? {},
    } as any
  })
}

describe('LearningPath island', () => {
  beforeEach(() => { document.documentElement.setAttribute('data-page-slug', 't-b') })

  it('renders ordered steps for the goal tutorial', async () => {
    global.fetch = mockFetch({
      '/auth/user': { json: { authenticated: false } },
      'learningPath': { json: { steps: [
        { order: 1, tutorialSlug: 't-a', teachesConcepts: ['a'], satisfiesPrereqFor: ['b'], alreadyPartial: false },
        { order: 2, tutorialSlug: 't-b', teachesConcepts: ['b'], satisfiesPrereqFor: [], alreadyPartial: false },
      ], totalSteps: 2, personalized: false } },
    })
    const w = mount(LearningPath, { props: { goalType: 'tutorial' } })
    await flushPromises()
    expect(w.text()).toContain('t-a')
    expect(w.text()).toContain('t-b')
  })

  it('renders nothing when endpoint 503s (flag off / master switch off)', async () => {
    global.fetch = mockFetch({ '/auth/user': { json: { authenticated: false } }, 'learningPath': { status: 503 } })
    const w = mount(LearningPath, { props: { goalType: 'tutorial' } })
    await flushPromises()
    expect(w.html().trim()).toBe('<!--v-if-->') // nothing rendered
  })

  it('renders nothing when steps is empty', async () => {
    global.fetch = mockFetch({ '/auth/user': { json: { authenticated: false } }, 'learningPath': { json: { steps: [], totalSteps: 0 } } })
    const w = mount(LearningPath, { props: { goalType: 'tutorial' } })
    await flushPromises()
    expect(w.html().trim()).toBe('<!--v-if-->')
  })
})
