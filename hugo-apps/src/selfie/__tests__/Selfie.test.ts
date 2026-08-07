// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('../segment', () => ({ removeBackground: vi.fn().mockResolvedValue({ blob: new Blob(['c'], { type: 'image/png' }), removed: true }) }))
vi.mock('../Capture.vue', () => ({ default: { name: 'Capture', emits: ['photo', 'error'], setup(_p: unknown, { emit }: { emit: (e: string, ...a: unknown[]) => void }) { return { doSnap: () => emit('photo', new Blob(['x'], { type: 'image/png' })) } }, template: '<button data-testid="fake-snap" @click="doSnap()">snap</button>' } }))
vi.mock('../Composer.vue', () => ({ default: { name: 'Composer', props: ['cutout', 'frameName', 'imgBase'], emits: ['export', 'fallback'], template: '<div data-testid="composer"></div>' } }))

import Selfie from '../Selfie.vue'

const config = { imgBase: '/images/devtoberfest/selfie', frames: ['Thomas', 'DJ2'] }

describe('Selfie.vue', () => {
  it('shows the privacy note that the photo never leaves the browser', () => {
    const w = mount(Selfie, { props: { config } })
    expect(w.text()).toMatch(/never leaves your browser/i)
  })

  it('advances to the composer after a frame is picked and a photo is captured', async () => {
    const w = mount(Selfie, { props: { config } })
    await w.findAll('.frame-thumb')[0].trigger('click')
    await w.find('[data-testid="fake-snap"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="composer"]').exists()).toBe(true)
  })
})
