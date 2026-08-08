// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const h = vi.hoisted(() => {
  const exportPng = vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  const addCutout = vi.fn(); const setImage = vi.fn()
  const addSticker = vi.fn(); const addEmoji = vi.fn()
  const addCaption = vi.fn(); const updateCaption = vi.fn(); const deleteSelected = vi.fn()
  const hasCaption = vi.fn().mockReturnValue(false)
  let selCb: ((k: string) => void) | null = null
  const onSelectionChange = vi.fn((cb: (k: string) => void) => { selCb = cb })
  const buildStage = vi.fn().mockResolvedValue({
    addCutout, setImage, exportPng, destroy: vi.fn(),
    addSticker, addEmoji, addCaption, updateCaption, deleteSelected, onSelectionChange,
    hasCaption, selectedIsCaption: () => false, deselect: vi.fn(),
  })
  return { exportPng, addCutout, setImage, addSticker, addEmoji, addCaption, updateCaption, deleteSelected, onSelectionChange, hasCaption, buildStage, fireSel: (k: string) => selCb?.(k) }
})
vi.mock('../compose', () => ({
  buildStage: h.buildStage,
}))

import Composer from '../Composer.vue'

const raw = new Blob(['raw'], { type: 'image/png' })
const cut = new Blob(['cut'], { type: 'image/png' })
const base = { frameName: 'Thomas', imgBase: '/images/devtoberfest/selfie', stickers: [{ name: 'pumpkin', file: 'pumpkin' }] }

beforeEach(() => {
  h.exportPng.mockClear(); h.addCutout.mockClear(); h.setImage.mockClear(); h.buildStage.mockClear()
  h.addSticker.mockClear(); h.addEmoji.mockClear(); h.addCaption.mockClear()
  h.updateCaption.mockClear(); h.deleteSelected.mockClear(); h.onSelectionChange.mockClear()
  h.hasCaption.mockReset(); h.hasCaption.mockReturnValue(false)
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

  it('Add caption calls stage.addCaption with the placeholder', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    await w.find('[data-testid="add-caption"]').trigger('click')
    expect(h.addCaption).toHaveBeenCalledWith('#Devtoberfest')
  })

  it('second Add caption click does not reset toolbar input when caption already exists', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    // First click: no caption yet → placeholder is set
    h.hasCaption.mockReturnValue(false)
    await w.find('[data-testid="add-caption"]').trigger('click')
    await flushPromises()
    // Simulate user typing a custom caption
    h.fireSel('caption'); await flushPromises()
    const field = w.find('[data-testid="caption-input"]')
    ;(field.element as HTMLInputElement).value = 'Hello'
    await field.trigger('input')
    expect((field.element as HTMLInputElement).value).toBe('Hello')
    // Second click: caption already exists → toolbar value must NOT revert to placeholder
    h.hasCaption.mockReturnValue(true)
    await w.find('[data-testid="add-caption"]').trigger('click')
    await flushPromises()
    const input = w.find('[data-testid="caption-input"]').element as HTMLInputElement
    expect(input.value).toBe('Hello')
  })

  it('caption input is disabled until a caption is selected', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    const input = () => w.find('[data-testid="caption-input"]').element as HTMLInputElement
    expect(input().disabled).toBe(true)
    h.fireSel('caption') // stage reports a caption is selected
    await flushPromises()
    expect(input().disabled).toBe(false)
  })

  it('typing in the caption field updates the caption on the stage', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    h.fireSel('caption'); await flushPromises()
    const field = w.find('[data-testid="caption-input"]')
    ;(field.element as HTMLInputElement).value = 'I met an advocate!'
    await field.trigger('input')
    expect(h.updateCaption).toHaveBeenCalledWith('I met an advocate!')
  })

  it('Delete is disabled with nothing selected and enabled once something is', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    const del = () => w.find('[data-testid="delete-overlay"]').element as HTMLButtonElement
    expect(del().disabled).toBe(true)
    h.fireSel('sticker'); await flushPromises()
    expect(del().disabled).toBe(false)
    await w.find('[data-testid="delete-overlay"]').trigger('click')
    expect(h.deleteSelected).toHaveBeenCalled()
  })

  it('adding an emoji from the palette calls stage.addEmoji', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    await w.find('[data-testid="tab-emoji"]').trigger('click')
    await w.findAll('.emoji-btn')[0].trigger('click')
    expect(h.addEmoji).toHaveBeenCalledTimes(1)
  })

  it('shows the polaroid preview matte only when the border is enabled', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    expect(w.find('[data-testid="polaroid-preview"]').classes()).not.toContain('is-bordered')
    // enable via the controls' toggle
    const cb = w.find('[data-testid="border-toggle"]')
    ;(cb.element as HTMLInputElement).checked = true
    await cb.trigger('change')
    await flushPromises()
    expect(w.find('[data-testid="polaroid-preview"]').classes()).toContain('is-bordered')
  })

  it('export with border OFF calls exportPng with no border arg', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    await w.find('[data-testid="export"]').trigger('click')
    await flushPromises()
    expect(h.exportPng).toHaveBeenCalledWith({ effect: 'none', border: undefined })
  })

  it('export with border ON forwards the current { style, name } to exportPng', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    // enable border
    const cb = w.find('[data-testid="border-toggle"]')
    ;(cb.element as HTMLInputElement).checked = true
    await cb.trigger('change')
    await flushPromises()
    // pick a style
    await w.find('[data-testid="border-style-joule"]').trigger('click')
    // type a name
    const nameField = w.find('[data-testid="border-name"]')
    ;(nameField.element as HTMLInputElement).value = 'Tom'
    await nameField.trigger('input')
    // export
    await w.find('[data-testid="export"]').trigger('click')
    await flushPromises()
    expect(h.exportPng).toHaveBeenCalledWith({ effect: 'none', border: { style: 'joule', name: 'Tom' } })
  })

  it('renders the effect picker', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    expect(w.find('[data-testid="effect-none"]').exists()).toBe(true)
    expect(w.find('[data-testid="effect-mono"]').exists()).toBe(true)
  })

  it('picking an effect forwards it to exportPng', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    await w.find('[data-testid="effect-mono"]').trigger('click')
    await w.find('[data-testid="export"]').trigger('click')
    await flushPromises()
    expect(h.exportPng).toHaveBeenCalledWith({ effect: 'mono', border: undefined })
  })

  it('a bordered export that rejects falls back to a plain download instead of throwing', async () => {
    const w = mount(Composer, { props: { rawPhoto: raw, cutout: cut, removeBg: true, segmenting: false, ...base } })
    await flushPromises()
    // enable the border so doExport takes the paintPolaroid branch
    const cb = w.find('[data-testid="border-toggle"]')
    ;(cb.element as HTMLInputElement).checked = true
    await cb.trigger('change')
    await flushPromises()
    // the bake rejects (e.g. paintPolaroid / toBlob failure)
    h.exportPng.mockRejectedValueOnce(new Error('bake failed'))
    await w.find('[data-testid="export"]').trigger('click')
    await flushPromises()
    // fail-soft: parent is asked to offer the un-bordered blob, no export emitted
    expect(w.emitted('export')).toBeUndefined()
    const payload = w.emitted('fallback')?.[0]?.[0] as Blob
    expect(payload).toBeInstanceOf(Blob)
  })
})
