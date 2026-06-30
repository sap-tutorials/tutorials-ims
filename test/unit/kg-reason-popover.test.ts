// @vitest-environment happy-dom
// test/unit/kg-reason-popover.test.ts
//
// Component tests for the KG sidebar hover-reason popover (KG widget
// UX polish, 2026-06-30). Validates trigger rendering, hover-intent
// timing, focus/blur parity, and the "no popover when reason is empty"
// rule. Does NOT exercise the ui5-popover web component itself
// (registered globally in production; rendered as an unknown element
// in happy-dom) — instead asserts on the `open` / `pop.open` property
// mutations the component drives.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import KgReasonPopover from '../../hugo-apps/src/related-graph/KgReasonPopover.vue'

describe('<KgReasonPopover>', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // ── Trigger rendering ──────────────────────────────────────────────

  it('renders <a> when href is set', () => {
    const wrapper = mount(KgReasonPopover, {
      props: { text: 'Hello', href: '/tutorials/x/', reason: 'because' },
    })
    expect(wrapper.find('a').exists()).toBe(true)
    expect(wrapper.find('a').attributes('href')).toBe('/tutorials/x/')
    expect(wrapper.find('a').text()).toBe('Hello')
    wrapper.unmount()
  })

  it('renders focusable <span> when href is absent', () => {
    const wrapper = mount(KgReasonPopover, {
      props: { text: 'Unpublished concept', reason: 'a description' },
    })
    expect(wrapper.find('a').exists()).toBe(false)
    const span = wrapper.find('span')
    expect(span.exists()).toBe(true)
    // tabindex="0" so keyboard users can focus and see the popover.
    expect(span.attributes('tabindex')).toBe('0')
    wrapper.unmount()
  })

  it('applies linkClass to the trigger element', () => {
    const w1 = mount(KgReasonPopover, {
      props: { text: 'A', href: '/x', reason: 'r', linkClass: 'kg-link' },
    })
    expect(w1.find('a').classes()).toContain('kg-link')
    w1.unmount()

    const w2 = mount(KgReasonPopover, {
      props: { text: 'B', reason: 'r', linkClass: 'kg-span' },
    })
    expect(w2.find('span').classes()).toContain('kg-span')
    w2.unmount()
  })

  it('does NOT set the native title= attribute on the trigger', () => {
    const wrapper = mount(KgReasonPopover, {
      props: { text: 'Hi', href: '/x', reason: 'reasoning' },
    })
    expect(wrapper.find('a').attributes('title')).toBeUndefined()
    wrapper.unmount()
  })

  it('renders no popover element when reason is null/empty', () => {
    const w1 = mount(KgReasonPopover, {
      props: { text: 'No reason', href: '/x', reason: null },
    })
    expect(w1.find('ui5-popover').exists()).toBe(false)
    w1.unmount()

    const w2 = mount(KgReasonPopover, {
      props: { text: 'Empty', href: '/x', reason: '' },
    })
    expect(w2.find('ui5-popover').exists()).toBe(false)
    w2.unmount()
  })

  it('renders the popover element when reason is non-empty', () => {
    const wrapper = mount(KgReasonPopover, {
      props: { text: 'Has reason', href: '/x', reason: 'why' },
    })
    expect(wrapper.find('ui5-popover').exists()).toBe(true)
    expect(wrapper.find('ui5-popover p').text()).toBe('why')
    wrapper.unmount()
  })

  // ── Hover-intent + accessibility ───────────────────────────────────
  // The popover element is an unknown custom element in happy-dom — we
  // can't drive its real `open` property to round-trip through UI5. We
  // CAN assert that mouseenter/mouseleave on the trigger set the popover
  // element's `open` property and that aria-describedby tracks the open
  // state.

  it('opens the popover on mouseenter after the 60ms enter delay', async () => {
    const wrapper = mount(KgReasonPopover, {
      attachTo: document.body, // ref binding needs a live DOM mount
      props: { text: 'Hover me', href: '/x', reason: 'why this' },
    })
    const trigger = wrapper.find('a')
    const popover = wrapper.find('ui5-popover').element as any

    // BEFORE hover: aria-describedby is absent (popover closed).
    expect(trigger.attributes('aria-describedby')).toBeUndefined()
    expect(popover.open).toBeFalsy()

    await trigger.trigger('mouseenter')
    // Within the 60 ms enter-window: still closed (filters out flyovers).
    vi.advanceTimersByTime(30)
    await flushPromises()
    expect(popover.open).toBeFalsy()

    // Cross the threshold.
    vi.advanceTimersByTime(50)
    await flushPromises()
    expect(popover.open).toBe(true)
    // aria-describedby flips to the popover's heading id when open.
    expect(trigger.attributes('aria-describedby')).toMatch(/^kg-reason-/)
    wrapper.unmount()
  })

  it('closes the popover after the 180ms leave delay (cursor bridge survives)', async () => {
    const wrapper = mount(KgReasonPopover, {
      attachTo: document.body,
      props: { text: 'Hover me', href: '/x', reason: 'why this' },
    })
    const trigger = wrapper.find('a')
    const popover = wrapper.find('ui5-popover').element as any

    // Open it.
    await trigger.trigger('mouseenter')
    vi.advanceTimersByTime(60)
    await flushPromises()
    expect(popover.open).toBe(true)

    // Mouse leaves the trigger.
    await trigger.trigger('mouseleave')
    // Within the 180 ms leave window: still open so the cursor can bridge.
    vi.advanceTimersByTime(100)
    await flushPromises()
    expect(popover.open).toBe(true)

    // Re-enter via the popover body — cancels the pending close.
    await wrapper.find('ui5-popover').trigger('mouseenter')
    vi.advanceTimersByTime(500)
    await flushPromises()
    expect(popover.open).toBe(true)

    // Leave the popover body too.
    await wrapper.find('ui5-popover').trigger('mouseleave')
    vi.advanceTimersByTime(200)
    await flushPromises()
    expect(popover.open).toBe(false)
    expect(trigger.attributes('aria-describedby')).toBeUndefined()
    wrapper.unmount()
  })

  it('opens on focus (keyboard parity with hover)', async () => {
    const wrapper = mount(KgReasonPopover, {
      attachTo: document.body,
      props: { text: 'Focus me', href: '/x', reason: 'because' },
    })
    const trigger = wrapper.find('a')
    const popover = wrapper.find('ui5-popover').element as any

    await trigger.trigger('focus')
    vi.advanceTimersByTime(80)
    await flushPromises()
    expect(popover.open).toBe(true)

    await trigger.trigger('blur')
    vi.advanceTimersByTime(200)
    await flushPromises()
    expect(popover.open).toBe(false)
    wrapper.unmount()
  })

  it('never opens when reason is empty (no-op hover)', async () => {
    const wrapper = mount(KgReasonPopover, {
      attachTo: document.body,
      props: { text: 'Silent', href: '/x', reason: null },
    })
    const trigger = wrapper.find('a')
    await trigger.trigger('mouseenter')
    vi.advanceTimersByTime(500)
    await flushPromises()
    // No popover element rendered, no opening to verify — but assert that
    // aria-describedby never appears.
    expect(trigger.attributes('aria-describedby')).toBeUndefined()
    wrapper.unmount()
  })

  // ── Click pass-through ─────────────────────────────────────────────
  it('emits "click" when the trigger anchor is clicked', async () => {
    const wrapper = mount(KgReasonPopover, {
      props: { text: 'Click me', href: '/x', reason: 'r' },
    })
    await wrapper.find('a').trigger('click')
    expect(wrapper.emitted('click')).toBeTruthy()
    expect(wrapper.emitted('click')!.length).toBe(1)
    wrapper.unmount()
  })
})
