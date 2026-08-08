// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const h = vi.hoisted(() => {
  const exportPng = vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  const addCutout = vi.fn()
  const setImage = vi.fn()
  const buildStage = vi.fn().mockResolvedValue({ addCutout, setImage, exportPng, destroy: vi.fn() })
  return { exportPng, addCutout, setImage, buildStage }
})
vi.mock('../compose', () => ({
  buildStage: h.buildStage,
}))

import Composer from '../Composer.vue'

const raw = new Blob(['raw'], { type: 'image/png' })
const cut = new Blob(['cut'], { type: 'image/png' })
const base = { frameName: 'Thomas', imgBase: '/images/devtoberfest/selfie' }

beforeEach(() => {
  h.exportPng.mockClear(); h.addCutout.mockClear(); h.setImage.mockClear(); h.buildStage.mockClear()
  // happy-dom does not fire <img> onload for blob: URLs, so Composer's
  // blobToImage() would hang forever. Stub Image to resolve on the next tick.
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    private _src = ''
    set src(v: string) { this._src = v; queueMicrotask(() => this.onload?.()) }
    get src() { return this._src }
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('Composer.vue', () => {
  it('emits export with a PNG blob when Export is clicked', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    await w.find('[data-testid="export"]').trigger('click')
    await flushPromises()
    const payload = w.emitted('export')?.[0]?.[0] as Blob
    expect(payload).toBeInstanceOf(Blob)
    expect(payload.type).toBe('image/png')
  })

  it('mounts showing the cutout when removeBg is on and a cutout exists', async () => {
    mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    expect(h.addCutout).toHaveBeenCalledTimes(1)
  })

  it('flipping removeBg OFF swaps the stage bitmap in place (setImage), no rebuild', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    h.buildStage.mockClear()
    await w.setProps({ removeBg: false })
    await flushPromises()
    expect(h.setImage).toHaveBeenCalledTimes(1) // swapped to the raw photo
    expect(h.buildStage).not.toHaveBeenCalled() // stage was NOT rebuilt
  })

  it('flipping removeBg ON with no cached cutout asks the parent to segment', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: null, removeBg: false, segmenting: false, ...base } })
    await flushPromises()
    await w.setProps({ removeBg: true })
    await flushPromises()
    expect(w.emitted('segment')).toHaveLength(1)
    expect(h.setImage).not.toHaveBeenCalled() // nothing to show yet
  })

  it('does not re-request segmentation while already segmenting', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: null, removeBg: false, segmenting: true, ...base } })
    await flushPromises()
    await w.setProps({ removeBg: true })
    await flushPromises()
    expect(w.emitted('segment')).toBeUndefined()
  })

  it('once the cutout arrives after an on-demand segment, it swaps in place', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: null, removeBg: true, segmenting: true, ...base } })
    await flushPromises()
    // Parent finishes segmentation and passes the cutout down.
    await w.setProps({ cutout: cut, segmenting: false })
    await flushPromises()
    expect(h.setImage).toHaveBeenCalledTimes(1)
  })

  it('checkbox reflects removeBg and is disabled while segmenting', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: null, removeBg: true, segmenting: true, ...base } })
    await flushPromises()
    const cb = w.find('[data-testid="remove-bg-compose"]')
    expect((cb.element as HTMLInputElement).checked).toBe(true)
    expect((cb.element as HTMLInputElement).disabled).toBe(true)
  })

  it('toggling the checkbox emits update:removeBg', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    const cb = w.find('[data-testid="remove-bg-compose"]')
    ;(cb.element as HTMLInputElement).checked = false
    await cb.trigger('change')
    expect(w.emitted('update:removeBg')?.[0]?.[0]).toBe(false)
  })
})
