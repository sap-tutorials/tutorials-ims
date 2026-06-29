// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref, nextTick } from 'vue'
import { useTelemetry, _resetTelemetry } from '../composables/useTelemetry'
import type { ExplorePayload } from '../types'

function makePayload(nodes = 0, edges = 0): ExplorePayload {
  return {
    nodes: Array.from({ length: nodes }, (_, i) => ({
      id: `n${i}`,
      type: 'tutorial',
      label: `n${i}`,
      slug: `n${i}`,
    })),
    edges: Array.from({ length: edges }, (_, i) => ({
      s: `n${i}`,
      p: 'relatedTo' as const,
      o: `n${i + 1}`,
    })),
    generatedAt: new Date().toISOString(),
  }
}

describe('useTelemetry', () => {
  beforeEach(() => {
    _resetTelemetry()
  })

  it('fires kg.explore.viewed when payload transitions from null to non-null', async () => {
    const listener = vi.fn()
    window.addEventListener('kg.explore.viewed', listener)
    const payload = ref<ExplorePayload | null>(null)
    const TestComp = defineComponent({
      setup() {
        useTelemetry({ payload })
      },
      template: '<div></div>',
    })
    mount(TestComp)
    // No payload yet — must not fire.
    expect(listener).not.toHaveBeenCalled()
    // Data arrives.
    payload.value = makePayload(3, 2)
    await nextTick()
    expect(listener).toHaveBeenCalledTimes(1)
    const evt = listener.mock.calls[0][0] as CustomEvent
    expect(evt.detail).toEqual({ nodeCount: 3, edgeCount: 2 })
    window.removeEventListener('kg.explore.viewed', listener)
  })

  it('fires immediately if payload is already populated at setup', async () => {
    const listener = vi.fn()
    window.addEventListener('kg.explore.viewed', listener)
    const payload = ref<ExplorePayload | null>(makePayload(1, 0))
    const TestComp = defineComponent({
      setup() {
        useTelemetry({ payload })
      },
      template: '<div></div>',
    })
    mount(TestComp)
    // `immediate: true` runs synchronously during setup.
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('kg.explore.viewed', listener)
  })

  it('fires kg.explore.viewed exactly once even with multiple consumers', async () => {
    const listener = vi.fn()
    window.addEventListener('kg.explore.viewed', listener)
    const payload = ref<ExplorePayload | null>(makePayload(2, 1))
    const TestComp = defineComponent({
      setup() {
        useTelemetry({ payload })
      },
      template: '<div></div>',
    })
    mount(TestComp)
    mount(TestComp)
    mount(TestComp)
    await nextTick()
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('kg.explore.viewed', listener)
  })
})
