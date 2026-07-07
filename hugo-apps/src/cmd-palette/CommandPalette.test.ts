// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import CommandPalette from './CommandPalette.vue'

function makeFetchMock(routes: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const key = Object.keys(routes).find(k => (url as string).includes(k))
    const body = key ? routes[key] : { value: [] }
    return { ok: true, json: async () => body }
  })
}

describe('CommandPalette — race guard on tutorial searcher', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('discards a stale in-flight tutorial response when the query has changed', async () => {
    // Two responses; the first (query 'ab') resolves slowly, the second
    // ('abcdef') resolves fast. When both land, the slow one must not
    // clobber the fast one.
    let resolveSlow: (v: unknown) => void = () => {}
    const slow = new Promise(r => { resolveSlow = r })
    const fast = Promise.resolve({ value: [
      { ID: '2', title: 'Fresh result', slug: 'fresh', description: '', primaryTag: null, averageTimeToComplete: null },
    ]})
    let callCount = 0
    globalThis.fetch = vi.fn(async (url: string) => {
      callCount++
      const body = callCount === 1 ? slow : fast
      return { ok: true, json: async () => await body }
    }) as unknown as typeof fetch

    const wrapper = mount(CommandPalette)
    ;(window as unknown as { openCommandPalette: () => void }).openCommandPalette()
    await flushPromises()

    const input = wrapper.find('input.cmdk__input')
    await input.setValue('ab')
    await vi.advanceTimersByTimeAsync(250)   // debounce fires, request 1 in flight

    await input.setValue('abcdef')
    await vi.advanceTimersByTimeAsync(250)   // debounce fires, request 2 completes fast
    await flushPromises()

    // Fast (second) request landed first with the "Fresh result" row.
    expect(wrapper.text()).toContain('Fresh result')

    // Now let the stale request resolve. Its result must be discarded.
    resolveSlow({ value: [
      { ID: '1', title: 'Stale result', slug: 'stale', description: '', primaryTag: null, averageTimeToComplete: null },
    ]})
    await flushPromises()

    expect(wrapper.text()).not.toContain('Stale result')
    expect(wrapper.text()).toContain('Fresh result')
  })
})

describe('CommandPalette — CONCEPTS group', () => {
  beforeEach(() => { vi.useFakeTimers() })

  afterEach(() => { vi.useRealTimers() })

  it('renders a CONCEPTS group with concept-name search results', async () => {
    globalThis.fetch = makeFetchMock({
      '/search/SearchableItems':   { value: [] },
      '/graph/PublishedConcepts':  { value: [
        { slug: 'cds-annotations',       name: 'CDS Annotations',       description: 'Metadata on CDS entities' },
        { slug: 'cds-associations',      name: 'CDS Associations',      description: 'Relations between entities' },
      ]},
    }) as unknown as typeof fetch

    const wrapper = mount(CommandPalette)
    ;(window as unknown as { openCommandPalette: () => void }).openCommandPalette()
    await flushPromises()

    await wrapper.find('input.cmdk__input').setValue('cds')
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    expect(wrapper.text()).toContain('Concepts')          // group heading
    expect(wrapper.text()).toContain('CDS Annotations')
    expect(wrapper.text()).toContain('CDS Associations')

    const conceptAnchor = wrapper.find('a[href="/concepts/cds-annotations/"]')
    expect(conceptAnchor.exists()).toBe(true)
  })

  it('hides the CONCEPTS group when no concept results are returned', async () => {
    globalThis.fetch = makeFetchMock({
      '/search/SearchableItems':   { value: [{ ID: 't', title: 'Only tutorial', slug: 'only', description: '', primaryTag: null, averageTimeToComplete: null }] },
      '/graph/PublishedConcepts':  { value: [] },
    }) as unknown as typeof fetch

    const wrapper = mount(CommandPalette)
    ;(window as unknown as { openCommandPalette: () => void }).openCommandPalette()
    await flushPromises()
    await wrapper.find('input.cmdk__input').setValue('xyz')
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    const groupLabels = wrapper.findAll('.cmdk__group-label').map(w => w.text())
    expect(groupLabels).not.toContain('Concepts')
    expect(wrapper.text()).toContain('Only tutorial')
  })
})

describe('CommandPalette — KNOWLEDGE GRAPH group', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('renders KG concept + tutorial rows, deduped against CONCEPTS/TUTORIALS', async () => {
    globalThis.fetch = makeFetchMock({
      '/search/SearchableItems':  { value: [
        { ID: 't1', title: 'Existing tutorial', slug: 'existing-tut', description: '', primaryTag: null, averageTimeToComplete: null },
      ]},
      '/graph/PublishedConcepts': { value: [
        { slug: 'cds-annotations', name: 'CDS Annotations', description: 'Metadata on entities' },
      ]},
      '/graph/searchKG':          {
        concepts: [
          { slug: 'cds-annotations', name: 'CDS Annotations',   score: 0.99 }, // dup — drop
          { slug: 'cds-associations', name: 'CDS Associations', score: 0.75 }, // fresh — keep
        ],
        tutorials: [
          { slug: 'existing-tut', title: 'Existing tutorial',   score: 0.90 }, // dup — drop
          { slug: 'fresh-tut',    title: 'Fresh KG tutorial',   score: 0.80 }, // fresh — keep
        ],
      },
    }) as unknown as typeof fetch

    const wrapper = mount(CommandPalette)
    ;(window as unknown as { openCommandPalette: () => void }).openCommandPalette()
    await flushPromises()
    await wrapper.find('input.cmdk__input').setValue('cds')
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    const groupLabels = wrapper.findAll('.cmdk__group-label').map(w => w.text())
    expect(groupLabels).toEqual(expect.arrayContaining(['Tutorials', 'Concepts', 'Knowledge Graph']))

    // Deduped: the KG row for cds-annotations must NOT appear again under KG.
    const kgRows = wrapper.findAll('.cmdk__group-label').at(-1)!
      .element.parentElement!.querySelectorAll('.cmdk__item')
    const kgLabels = Array.from(kgRows).map(el => el.textContent || '')
    expect(kgLabels.join(' ')).toContain('CDS Associations')
    expect(kgLabels.join(' ')).toContain('Fresh KG tutorial')
    // dup checks — labels are still allowed to APPEAR in the DOM under
    // their non-KG group; we care that they don't appear under KG.
    const kgSectionText = Array.from(kgRows).map(el => el.textContent).join(' ')
    // The dup 'Existing tutorial' from KG should be filtered out of the KG section.
    // (It legitimately still shows under TUTORIALS.)
    expect(kgSectionText).not.toContain('Existing tutorial')
    // The dup 'CDS Annotations' concept from KG should be filtered out of the KG section.
    expect(kgSectionText).not.toContain('CDS Annotations')
  })

  it('hides KG group when /graph/searchKG returns 500 or throws', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/graph/searchKG')) return { ok: false, status: 500, json: async () => ({}) }
      if (url.includes('/search/SearchableItems')) return { ok: true, json: async () => ({ value: [] }) }
      if (url.includes('/graph/PublishedConcepts'))  return { ok: true, json: async () => ({ value: [] }) }
      return { ok: false, json: async () => ({}) }
    }) as unknown as typeof fetch

    const wrapper = mount(CommandPalette)
    ;(window as unknown as { openCommandPalette: () => void }).openCommandPalette()
    await flushPromises()
    await wrapper.find('input.cmdk__input').setValue('anything')
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    const groupLabels = wrapper.findAll('.cmdk__group-label').map(w => w.text())
    expect(groupLabels).not.toContain('Knowledge Graph')
    // Empty-state message should render since nothing else matched either.
    expect(wrapper.text()).toContain('No matches.')
  })
})
