// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const removeBackground = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ blob: new Blob(['c'], { type: 'image/png' }), removed: true }),
)
vi.mock('../segment', () => ({ removeBackground }))
vi.mock('../Capture.vue', () => ({ default: { name: 'Capture', emits: ['photo', 'error'], setup(_p: unknown, { emit }: { emit: (e: string, ...a: unknown[]) => void }) { return { doSnap: () => emit('photo', new Blob(['x'], { type: 'image/png' })) } }, template: '<button data-testid="fake-snap" @click="doSnap()">snap</button>' } }))
vi.mock('../Composer.vue', () => ({ default: { name: 'Composer', props: ['rawPhoto', 'cutout', 'removeBg', 'segmenting', 'frameName', 'imgBase'], emits: ['export', 'fallback', 'update:removeBg', 'segment'], template: '<div data-testid="composer"></div>' } }))

import Selfie from '../Selfie.vue'

const config = { imgBase: '/images/devtoberfest/selfie', frames: ['Thomas', 'DJ2'] }

async function pickFrameAndSnap(w: ReturnType<typeof mount>) {
  await w.findAll('.frame-thumb')[0].trigger('click')
  await w.find('[data-testid="fake-snap"]').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  removeBackground.mockClear()
  removeBackground.mockResolvedValue({ blob: new Blob(['c'], { type: 'image/png' }), removed: true })
})

describe('Selfie.vue', () => {
  it('shows the privacy note that the photo never leaves the browser', () => {
    const w = mount(Selfie, { props: { config } })
    expect(w.text()).toMatch(/never leaves your browser/i)
  })

  it('advances to the composer after a frame is picked and a photo is captured', async () => {
    const w = mount(Selfie, { props: { config } })
    await pickFrameAndSnap(w)
    expect(w.find('[data-testid="composer"]').exists()).toBe(true)
  })

  it('removes the background by default (toggle ON), running segmentation on capture', async () => {
    const w = mount(Selfie, { props: { config } })
    await w.findAll('.frame-thumb')[0].trigger('click')
    // The capture-step toggle is present and checked by default.
    const cb = w.find('[data-testid="remove-bg-capture"]')
    expect(cb.exists()).toBe(true)
    expect((cb.element as HTMLInputElement).checked).toBe(true)
    await w.find('[data-testid="fake-snap"]').trigger('click')
    await flushPromises()
    expect(removeBackground).toHaveBeenCalledTimes(1)
  })

  it('skips the ~76MB model entirely when the user opts out before capturing', async () => {
    const w = mount(Selfie, { props: { config } })
    await w.findAll('.frame-thumb')[0].trigger('click')
    // Opt out at the capture step.
    const cb = w.find('[data-testid="remove-bg-capture"]')
    await cb.setValue(false)
    await w.find('[data-testid="fake-snap"]').trigger('click')
    await flushPromises()
    expect(removeBackground).not.toHaveBeenCalled()
    // Still lands on the composer — with the raw photo.
    expect(w.find('[data-testid="composer"]').exists()).toBe(true)
  })

  it('falls back to the full photo and flips the toggle off when segmentation fails', async () => {
    removeBackground.mockResolvedValue({ blob: new Blob(['x'], { type: 'image/png' }), removed: false })
    const w = mount(Selfie, { props: { config } })
    await pickFrameAndSnap(w)
    // Reaches the composer despite the failure, and surfaces the fallback notice.
    expect(w.find('[data-testid="composer"]').exists()).toBe(true)
    expect(w.text()).toMatch(/using your full photo/i)
  })
})
