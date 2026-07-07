// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import CommandPalette from './CommandPalette.vue'

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
