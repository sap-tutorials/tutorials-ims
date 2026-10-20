// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// The realtime composable opens a socket.io connection; stub it so mounting
// does not attempt a real WebSocket in tests.
vi.mock('../useRealtimeProgress', async () => {
  const { ref } = await import('vue')
  return { useRealtimeProgress: () => ({ lastCompletion: ref(null), connected: ref(false) }) }
})

import AppSpace from '../AppSpace.vue'
import { checkpointBarcodeUrl, shouldShowCheckpointBarcode } from '../checkpoint-barcode'

function stubFetch(handler: (url: string) => { ok: boolean; status: number; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const { ok, status, body } = handler(String(input))
    return { ok, status, json: async () => body }
  }) as unknown as typeof fetch)
}

// ── Pure helper unit tests ──────────────────────────────────────────────────

const checkpointItem = { type: 'CHECKPOINT' as const, status: '' }
const tutorialItem   = { type: 'TUTORIAL' as const,   status: 'COMPLETED' }

describe('checkpointBarcodeUrl', () => {
  it('returns the exact prize-barcode URL with the eventId', () => {
    expect(checkpointBarcodeUrl(42)).toBe('/api/my-prize-barcode?eventId=42')
  })

  it('defaults eventId to 0 when null is passed', () => {
    expect(checkpointBarcodeUrl(null)).toBe('/api/my-prize-barcode?eventId=0')
  })
})

describe('shouldShowCheckpointBarcode', () => {
  it('returns true when item is CHECKPOINT, unlocked=true, authenticated=true', () => {
    expect(shouldShowCheckpointBarcode(checkpointItem, true, true)).toBe(true)
  })

  it('returns false when CHECKPOINT + unlocked but NOT authenticated', () => {
    expect(shouldShowCheckpointBarcode(checkpointItem, true, false)).toBe(false)
  })

  it('returns false when CHECKPOINT + authenticated but NOT unlocked', () => {
    expect(shouldShowCheckpointBarcode(checkpointItem, false, true)).toBe(false)
  })

  it('returns false when item is TUTORIAL even if unlocked=true and authenticated=true', () => {
    expect(shouldShowCheckpointBarcode(tutorialItem, true, true)).toBe(false)
  })
})

// ── Integration / render tests ──────────────────────────────────────────────

const makePayload = (authenticated: boolean, allComplete: boolean) => ({
  eventId: 10000005,
  eventName: 'TechEd 2026',
  eventType: 'TECHED',
  authenticated,
  type: 'COMPLEX',
  paths: [{
    id: 1, title: 'Track A', description: '', items: [
      { imsId: 1, title: 'Tut 1', type: 'TUTORIAL', status: allComplete ? 'COMPLETED' : '', progress: allComplete ? 100 : 0, experience: '', timeToComplete: 0, url: '/tutorials/x.html', description: '' },
      { imsId: 99, title: 'Checkpoint', type: 'CHECKPOINT', status: '', progress: 0, experience: '', timeToComplete: 0, url: '', description: '' },
    ]
  }]
})

describe('AppSpace checkpoint barcode render', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/app-space/?eventId=10000005')
  })

  it('shows the barcode img when authenticated and track complete', async () => {
    stubFetch((url) => {
      if (url.includes('getAppSpaceProgress')) return { ok: true, status: 200, body: makePayload(true, true) }
      return { ok: false, status: 404, body: {} }
    })

    const wrapper = mount(AppSpace)
    await flushPromises()

    // Navigate to the track detail view
    const trackCard = wrapper.find('.track-card')
    expect(trackCard.exists()).toBe(true)
    await trackCard.trigger('click')
    await flushPromises()

    const barcodeImg = wrapper.find('.checkpoint-barcode__img')
    expect(barcodeImg.exists()).toBe(true)
    expect(barcodeImg.attributes('src')).toBe('/api/my-prize-barcode?eventId=10000005')
    // Sign-in hint must NOT appear
    expect(wrapper.find('.checkpoint-signin-hint').exists()).toBe(false)
  })

  it('shows sign-in hint (not barcode) when NOT authenticated but track complete', async () => {
    stubFetch((url) => {
      if (url.includes('getAppSpaceProgress')) return { ok: true, status: 200, body: makePayload(false, true) }
      return { ok: false, status: 404, body: {} }
    })

    const wrapper = mount(AppSpace)
    await flushPromises()

    const trackCard = wrapper.find('.track-card')
    await trackCard.trigger('click')
    await flushPromises()

    expect(wrapper.find('.checkpoint-barcode__img').exists()).toBe(false)
    expect(wrapper.find('.checkpoint-signin-hint').exists()).toBe(true)
  })

  it('shows neither barcode nor hint when track is incomplete', async () => {
    stubFetch((url) => {
      if (url.includes('getAppSpaceProgress')) return { ok: true, status: 200, body: makePayload(true, false) }
      return { ok: false, status: 404, body: {} }
    })

    const wrapper = mount(AppSpace)
    await flushPromises()

    const trackCard = wrapper.find('.track-card')
    await trackCard.trigger('click')
    await flushPromises()

    expect(wrapper.find('.checkpoint-barcode__img').exists()).toBe(false)
    expect(wrapper.find('.checkpoint-signin-hint').exists()).toBe(false)
  })

  it('sets authenticated=false from data.authenticated=false (Task 4)', async () => {
    stubFetch((url) => {
      if (url.includes('getAppSpaceProgress')) return { ok: true, status: 200, body: makePayload(false, true) }
      return { ok: false, status: 404, body: {} }
    })

    const wrapper = mount(AppSpace)
    await flushPromises()

    // Authenticated is false, so barcode must not render even on a complete track
    const trackCard = wrapper.find('.track-card')
    await trackCard.trigger('click')
    await flushPromises()

    expect(wrapper.find('.checkpoint-barcode__img').exists()).toBe(false)
    expect(wrapper.find('.checkpoint-signin-hint').exists()).toBe(true)
  })
})
