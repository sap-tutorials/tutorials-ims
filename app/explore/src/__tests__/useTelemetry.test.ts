// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { useTelemetry, _resetTelemetry } from '../composables/useTelemetry'

describe('useTelemetry', () => {
  beforeEach(() => {
    _resetTelemetry()
    // Reset any window injected initial graph
    ;(window as any).__INITIAL_GRAPH__ = { nodes: [], edges: [] }
  })

  it('fires kg.explore.viewed on mount', () => {
    const listener = vi.fn()
    window.addEventListener('kg.explore.viewed', listener)
    const TestComp = defineComponent({
      setup() {
        useTelemetry()
      },
      template: '<div></div>',
    })
    mount(TestComp)
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('kg.explore.viewed', listener)
  })

  it('fires kg.explore.viewed exactly once even with multiple consumers', () => {
    const listener = vi.fn()
    window.addEventListener('kg.explore.viewed', listener)
    const TestComp = defineComponent({
      setup() {
        useTelemetry()
      },
      template: '<div></div>',
    })
    mount(TestComp)
    mount(TestComp)
    mount(TestComp)
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('kg.explore.viewed', listener)
  })
})
